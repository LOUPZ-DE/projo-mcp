import type { Request, Response } from 'express';
import { config } from '../config.js';
import { randomToken } from './pkce.js';
import { getClient, getPendingAuth, pendingAuths, users, type PendingAuth } from './store.js';
import { completeAuthorization } from './complete.js';
import { getSession, setSession } from '../authn/session.js';
import { renderLoginPage } from '../authn/loginPage.js';
import { renderErrorPage } from '../util/html.js';
import { log } from '../util/log.js';

const PENDING_TTL_MS = 10 * 60 * 1000;

// ─── Helpers ────────────────────────────────────────────────────────────────

/** resource-Parameter (RFC 8707) — kann mehrfach vorkommen → erstes Element. */
function firstParam(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

function redirectWithError(res: Response, redirectUri: string, error: string, description: string, state?: string): void {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state !== undefined) url.searchParams.set('state', state);
  // RFC 9207: iss auch in Fehler-Responses (s. complete.ts)
  url.searchParams.set('iss', config.BASE_URL);
  res.redirect(302, url.toString());
}

// ─── GET /authorize ─────────────────────────────────────────────────────────

export function authorizeGetHandler(req: Request, res: Response): void {
  const q = req.query;
  const clientId = firstParam(q.client_id);
  const redirectUri = firstParam(q.redirect_uri);
  const responseType = firstParam(q.response_type);
  const state = firstParam(q.state);
  const codeChallenge = firstParam(q.code_challenge);
  const codeChallengeMethod = firstParam(q.code_challenge_method);
  const scope = firstParam(q.scope);
  const resource = firstParam(q.resource);
  // Notion-spezifisch: wird beim Authorize-Request mitgeschickt (Identität des Notion-Nutzers)
  const notionUserId = firstParam(q.notion_user_id);
  if (notionUserId) {
    log('info', 'Authorize: notion_user_id empfangen', { notionUserId, clientId });
  }

  // 1) client_id prüfen — vor jedem Redirect, Fehler als HTML-Seite
  if (!clientId) {
    renderErrorPage(res, 400, 'Ungültiger Authorization-Request', 'Parameter client_id fehlt.');
    return;
  }
  const client = getClient(clientId);
  if (!client) {
    renderErrorPage(res, 400, 'Ungültiger Authorization-Request', `Unbekannte client_id: ${clientId}`);
    return;
  }

  // 2) redirect_uri: exakter String-Match gegen registrierte URIs (kein Prefix-Matching!)
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    renderErrorPage(res, 400, 'Ungültiger Authorization-Request', 'redirect_uri fehlt oder ist für diesen Client nicht registriert.');
    return;
  }

  // Ab hier ist redirect_uri vertrauenswürdig → Fehler dürfen per Redirect gemeldet werden.
  if (responseType !== 'code') {
    redirectWithError(res, redirectUri, 'unsupported_response_type', 'Nur response_type=code wird unterstützt', state);
    return;
  }
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    redirectWithError(res, redirectUri, 'invalid_request', 'PKCE mit code_challenge_method=S256 ist Pflicht', state);
    return;
  }

  // RFC 8707: resource prüfen — Mismatch nur warnen (Testserver-Modus: akzeptieren + lernen)
  if (resource && resource !== config.MCP_RESOURCE) {
    log('warn', 'Authorize: resource-Param weicht von MCP_RESOURCE ab', { resource, expected: config.MCP_RESOURCE });
  }

  const txn = randomToken(24);
  const pending: PendingAuth = {
    clientId,
    redirectUri,
    state,
    codeChallenge,
    scope,
    resource,
    notionUserId,
    expiresAt: Date.now() + PENDING_TTL_MS,
  };
  pendingAuths.set(txn, pending);

  // Bereits eingeloggt (lokale Session oder SSO-Session)? → Login überspringen
  const session = getSession(req);
  if (session) {
    pendingAuths.delete(txn);
    completeAuthorization(res, pending, session);
    return;
  }

  renderLoginPage(res, { txn, clientName: client.client_name, scope });
}

// ─── POST /authorize (lokaler Login; SSO läuft über /auth/:provider/*) ─────

export function authorizePostHandler(req: Request, res: Response): void {
  if (!config.localEnabled) {
    renderErrorPage(res, 400, 'Lokaler Login deaktiviert', 'Dieser Server akzeptiert nur SSO-Logins (AUTH_PROVIDERS ohne local).');
    return;
  }

  const body = req.body as Record<string, unknown>;
  const txn = typeof body.txn === 'string' ? body.txn : undefined;
  const email = typeof body.email === 'string' ? body.email : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const pending = txn ? getPendingAuth(txn) : undefined;
  if (!pending) {
    renderErrorPage(res, 400, 'Anfrage abgelaufen', 'Die Autorisierungsanfrage ist unbekannt oder abgelaufen — bitte den Sign-in erneut starten.');
    return;
  }
  const client = getClient(pending.clientId);

  const user = users.get(email.toLowerCase());
  if (!user || user.password !== password) {
    log('info', 'Authorize: Login fehlgeschlagen', { email });
    renderLoginPage(res, { txn: txn!, clientName: client?.client_name, scope: pending.scope, error: 'E-Mail oder Passwort falsch.' });
    return;
  }

  pendingAuths.delete(txn!);
  const identity = { email: user.email, name: user.name, idp: 'local' };
  setSession(res, identity);
  completeAuthorization(res, pending, identity);
}
