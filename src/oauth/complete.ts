import type { Response } from 'express';
import { config } from '../config.js';
import { randomToken } from './pkce.js';
import { authCodes, type PendingAuth } from './store.js';
import type { AuthnIdentity } from '../authn/identity.js';
import { log } from '../util/log.js';

const CODE_TTL_MS = 10 * 60 * 1000;

/**
 * ZENTRALE AUSTAUSCH-NAHTSTELLE zwischen Login und OAuth.
 *
 * Jede Login-Methode (lokales Formular, SSO via IdP, oder in späteren Projekten
 * eine bestehende App-Session) endet hier: Sobald eine AuthnIdentity vorliegt,
 * stellt diese Funktion den Authorization Code aus und redirected zum Client.
 * Alles davor (WIE der Nutzer authentifiziert wird) ist austauschbar,
 * alles danach (Token, JWT, MCP) bleibt unverändert.
 */
export function completeAuthorization(res: Response, pending: PendingAuth, identity: AuthnIdentity): void {
  const code = randomToken(32);
  authCodes.set(code, {
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    scope: pending.scope,
    resource: pending.resource,
    email: identity.email,
    name: identity.name,
    idp: identity.idp,
    notionUserId: pending.notionUserId,
    expiresAt: Date.now() + CODE_TTL_MS,
  });
  const url = new URL(pending.redirectUri);
  url.searchParams.set('code', code);
  if (pending.state !== undefined) url.searchParams.set('state', pending.state);
  // RFC 9207 (SHOULD, MCP-Spec 2026-07-28): Issuer-Identifikation in der Authorization
  // Response — Clients MÜSSEN ein vorhandenes iss gegen den erwarteten Issuer prüfen
  // (Schutz gegen Authorization-Server-Mix-up).
  url.searchParams.set('iss', config.BASE_URL);
  log('info', 'Authorize: Code ausgestellt', {
    clientId: pending.clientId,
    email: identity.email,
    idp: identity.idp,
    scope: pending.scope,
    resource: pending.resource,
    notionUserId: pending.notionUserId,
  });
  res.redirect(302, url.toString());
}
