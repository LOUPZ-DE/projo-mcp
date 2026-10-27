import type { Request, Response } from 'express';
import { jwtVerify } from 'jose';
import { config } from '../config.js';
import { getIdp, isEmailAllowed } from '../authn/idp/registry.js';
import { setSession } from '../authn/session.js';
import { randomToken, s256Challenge } from '../oauth/pkce.js';
import { renderErrorPage } from '../util/html.js';
import { log } from '../util/log.js';

/**
 * Anmeldung an diesem Server direkt auf der Verbindungsseite – für den Fall, dass das `mcp_session`-Cookie
 * aus dem OAuth-Connect im aktuellen Browser fehlt. Gleicher OIDC-Ablauf wie im Template
 * (Authorization Code + PKCE S256 + nonce, id_token per JWKS geprüft), endet aber mit Redirect auf /connect.
 * Redirect-URI beim IdP zusätzlich registrieren: https://<host>/connect/auth/<provider>/callback
 */

interface ConnectTxn {
  providerKey: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const txns = new Map<string, ConnectTxn>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of txns) if (v.expiresAt <= now) txns.delete(k);
}, 60_000).unref();

const callbackUrl = (key: string) => `${config.BASE_URL}/connect/auth/${key}/callback`;
const first = (v: unknown) => (Array.isArray(v) ? (typeof v[0] === 'string' ? v[0] : undefined) : typeof v === 'string' ? v : undefined);

export function connectIdpStart(req: Request, res: Response): void {
  const provider = getIdp(req.params.provider as string);
  if (!provider) {
    renderErrorPage(res, 404, 'Unbekannter Provider', `Der Provider '${String(req.params.provider)}' ist nicht aktiv.`);
    return;
  }
  const state = randomToken(24);
  const txn: ConnectTxn = { providerKey: provider.key, nonce: randomToken(24), codeVerifier: randomToken(48), expiresAt: Date.now() + TTL_MS };
  txns.set(state, txn);
  const url = new URL(provider.authorizationEndpoint);
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('redirect_uri', callbackUrl(provider.key));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', provider.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', txn.nonce);
  url.searchParams.set('code_challenge', s256Challenge(txn.codeVerifier));
  url.searchParams.set('code_challenge_method', 'S256');
  res.redirect(302, url.toString());
}

export async function connectIdpCallback(req: Request, res: Response): Promise<void> {
  const provider = getIdp(req.params.provider as string);
  if (!provider) {
    renderErrorPage(res, 404, 'Unbekannter Provider', `Der Provider '${String(req.params.provider)}' ist nicht aktiv.`);
    return;
  }
  const error = first(req.query.error);
  if (error) {
    renderErrorPage(res, 400, 'Anmeldung abgebrochen', `${provider.displayName}: ${first(req.query.error_description) ?? error}`);
    return;
  }
  const code = first(req.query.code);
  const state = first(req.query.state);
  const txn = state ? txns.get(state) : undefined;
  if (state) txns.delete(state); // single use
  if (!code || !txn || txn.expiresAt <= Date.now() || txn.providerKey !== provider.key) {
    renderErrorPage(res, 400, 'Anmeldung abgelaufen', 'Bitte die Anmeldung auf der Verbindungsseite erneut starten.');
    return;
  }

  try {
    const tokenRes = await fetch(provider.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl(provider.key),
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code_verifier: txn.codeVerifier,
      }),
    });
    const tokens = (await tokenRes.json()) as { id_token?: string; error_description?: string; error?: string };
    if (!tokens.id_token) throw new Error(tokens.error_description ?? tokens.error ?? 'kein id_token');
    const { payload } = await jwtVerify(tokens.id_token, provider.jwks, { issuer: provider.issuer, audience: provider.clientId });
    if (payload.nonce !== txn.nonce) throw new Error('nonce stimmt nicht');
    const identity = provider.mapClaims(payload);
    if (!identity) throw new Error('keine E-Mail-Adresse in den Claims');
    if (!isEmailAllowed(identity.email)) {
      renderErrorPage(res, 403, 'Zugriff verweigert', `Das Konto ${identity.email} ist für diesen Server nicht freigeschaltet.`);
      return;
    }
    setSession(res, { email: identity.email, name: identity.name, idp: provider.key });
    log('info', 'Connect: Anmeldung per SSO', { provider: provider.key, email: identity.email });
    res.redirect(302, '/connect');
  } catch (err) {
    log('warn', 'Connect: SSO-Anmeldung fehlgeschlagen', { provider: provider.key, error: err instanceof Error ? err.message : String(err) });
    renderErrorPage(res, 502, 'Anmeldung fehlgeschlagen', `${provider.displayName}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
