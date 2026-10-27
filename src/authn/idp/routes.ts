import type { Request, Response } from 'express';
import { jwtVerify, type JWTPayload } from 'jose';
import { config } from '../../config.js';
import { randomToken, s256Challenge } from '../../oauth/pkce.js';
import { getIdpTxn, getPendingAuth, idpTxns, pendingAuths } from '../../oauth/store.js';
import { completeAuthorization } from '../../oauth/complete.js';
import { renderErrorPage } from '../../util/html.js';
import { log } from '../../util/log.js';
import { setSession } from '../session.js';
import { getIdp, isEmailAllowed } from './registry.js';

const IDP_TTL_MS = 10 * 60 * 1000;

function firstParam(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

function callbackUrl(providerKey: string): string {
  return `${config.BASE_URL}/auth/${providerKey}/callback`;
}

/**
 * GET /auth/:provider/start?txn=<pendingAuthId>
 * Startet den OIDC-Flow zum IdP (Authorization Code + PKCE S256 + nonce).
 * Der `state` zum IdP ist zugleich der Key in idpTxns und verbindet so
 * unsere Notion-Transaktion (txn) mit der IdP-Rundreise.
 */
export function idpStartHandler(req: Request, res: Response): void {
  const provider = getIdp(req.params.provider as string);
  if (!provider) {
    renderErrorPage(res, 404, 'Unbekannter Provider', `Der Provider '${req.params.provider}' ist nicht aktiv.`);
    return;
  }
  const txn = firstParam(req.query.txn);
  if (!txn || !getPendingAuth(txn)) {
    renderErrorPage(res, 400, 'Anfrage abgelaufen', 'Die Autorisierungsanfrage ist unbekannt oder abgelaufen — bitte den Sign-in erneut starten.');
    return;
  }

  const state = randomToken(24);
  const nonce = randomToken(24);
  const codeVerifier = randomToken(48); // 64 base64url-Zeichen, RFC-7636-konform
  idpTxns.set(state, {
    txn,
    providerKey: provider.key,
    nonce,
    codeVerifier,
    expiresAt: Date.now() + IDP_TTL_MS,
  });

  const url = new URL(provider.authorizationEndpoint);
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('redirect_uri', callbackUrl(provider.key));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', provider.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', s256Challenge(codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');

  log('info', 'SSO: Redirect zum IdP', { provider: provider.key });
  res.redirect(302, url.toString());
}

interface IdpTokenResponse {
  id_token?: string;
  error?: string;
  error_description?: string;
}

/**
 * GET /auth/:provider/callback?code&state (oder ?error)
 * Tauscht den Code am IdP, verifiziert das id_token (JWKS + iss + aud + nonce),
 * prüft die Allowlist und schließt die Autorisierung ab (completeAuthorization).
 */
export async function idpCallbackHandler(req: Request, res: Response): Promise<void> {
  const provider = getIdp(req.params.provider as string);
  if (!provider) {
    renderErrorPage(res, 404, 'Unbekannter Provider', `Der Provider '${req.params.provider}' ist nicht aktiv.`);
    return;
  }

  const q = req.query;
  const errorParam = firstParam(q.error);
  if (errorParam) {
    log('info', 'SSO: IdP hat abgebrochen', { provider: provider.key, error: errorParam, description: firstParam(q.error_description) });
    renderErrorPage(res, 400, 'Anmeldung abgebrochen', `${provider.displayName}: ${firstParam(q.error_description) ?? errorParam}`);
    return;
  }

  const code = firstParam(q.code);
  const state = firstParam(q.state);
  const idpTxn = state ? getIdpTxn(state) : undefined;
  if (!code || !idpTxn) {
    renderErrorPage(res, 400, 'Ungültige Antwort', 'state unbekannt/abgelaufen oder code fehlt — bitte den Sign-in erneut starten.');
    return;
  }
  idpTxns.delete(state!); // single use

  const pending = getPendingAuth(idpTxn.txn);
  if (!pending) {
    renderErrorPage(res, 400, 'Anfrage abgelaufen', 'Die Autorisierungsanfrage ist abgelaufen — bitte den Sign-in erneut starten.');
    return;
  }

  // 1) Code am IdP-Token-Endpoint tauschen (confidential client + PKCE)
  let tokenResponse: IdpTokenResponse;
  try {
    const resp = await fetch(provider.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl(provider.key),
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code_verifier: idpTxn.codeVerifier,
      }),
    });
    tokenResponse = (await resp.json()) as IdpTokenResponse;
  } catch (err) {
    log('error', 'SSO: IdP-Token-Endpoint nicht erreichbar', { provider: provider.key, error: err instanceof Error ? err.message : String(err) });
    renderErrorPage(res, 502, 'IdP nicht erreichbar', `Der Token-Endpoint von ${provider.displayName} antwortet nicht.`);
    return;
  }
  if (!tokenResponse.id_token) {
    log('warn', 'SSO: kein id_token vom IdP', { provider: provider.key, error: tokenResponse.error, description: tokenResponse.error_description });
    renderErrorPage(res, 502, 'IdP-Fehler', tokenResponse.error_description ?? tokenResponse.error ?? 'Der IdP hat kein id_token geliefert.');
    return;
  }

  // 2) id_token verifizieren: Signatur (JWKS), iss, aud — danach nonce
  let claims: JWTPayload;
  try {
    const { payload } = await jwtVerify(tokenResponse.id_token, provider.jwks, {
      issuer: provider.issuer,
      audience: provider.clientId,
    });
    claims = payload;
  } catch (err) {
    log('warn', 'SSO: id_token-Verifizierung fehlgeschlagen', { provider: provider.key, error: err instanceof Error ? err.message : String(err) });
    renderErrorPage(res, 502, 'IdP-Token ungültig', 'Die Signatur/Aussteller-Prüfung des id_token ist fehlgeschlagen.');
    return;
  }
  if (claims.nonce !== idpTxn.nonce) {
    log('warn', 'SSO: nonce-Mismatch', { provider: provider.key });
    renderErrorPage(res, 400, 'IdP-Token ungültig', 'nonce stimmt nicht mit der Anfrage überein.');
    return;
  }

  // 3) Claims → Identität, Allowlist
  const identity = provider.mapClaims(claims);
  if (!identity) {
    log('warn', 'SSO: keine verwertbare E-Mail in den Claims', { provider: provider.key, claims: Object.keys(claims) });
    renderErrorPage(res, 400, 'Unvollständige Identität', `${provider.displayName} hat keine E-Mail-Adresse geliefert.`);
    return;
  }
  if (!isEmailAllowed(identity.email)) {
    log('warn', 'SSO: Login durch Allowlist abgelehnt', { provider: provider.key, email: identity.email });
    renderErrorPage(res, 403, 'Zugriff verweigert', `Das Konto ${identity.email} ist für diesen Server nicht freigeschaltet.`);
    return;
  }

  // 4) Abschluss wie bei jedem Login: Session + Authorization Code → Redirect zu Notion
  log('info', 'SSO: Login erfolgreich', { provider: provider.key, email: identity.email, sub: identity.subject });
  pendingAuths.delete(idpTxn.txn);
  const authnIdentity = { email: identity.email, name: identity.name, idp: provider.key };
  setSession(res, authnIdentity);
  completeAuthorization(res, pending, authnIdentity);
}
