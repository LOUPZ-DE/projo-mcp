import type { Response } from 'express';
import type { AuthnIdentity } from '../authn/identity.js';
import { completeAuthorization } from '../oauth/complete.js';
import { randomToken } from '../oauth/pkce.js';
import { getClient, type PendingAuth } from '../oauth/store.js';
import { projoSessions } from '../projo/runtime.js';
import { log } from '../util/log.js';

/**
 * Verbinden in einem Durchgang: Nach der Anmeldung am MCP-Server (OAuth-Connect aus Notion/Claude) prüft der
 * Server, ob schon eine projo-Verbindung besteht. Nur wenn nicht, wird der OAuth-Abschluss zurückgehalten und
 * die Verbindungsseite als „Schritt 2 von 2“ gezeigt – danach (oder per „Überspringen“) geht es automatisch
 * mit dem Authorization Code zurück zum Client.
 */

interface ConnectFlow {
  pending: PendingAuth;
  identity: AuthnIdentity;
  clientName?: string;
  expiresAt: number;
}

const FLOW_TTL_MS = 15 * 60 * 1000;
const flows = new Map<string, ConnectFlow>();
setInterval(() => {
  const now = Date.now();
  for (const [id, f] of flows) if (f.expiresAt <= now) flows.delete(id);
}, 60_000).unref();

/** Ersatz für completeAuthorization an allen Login-Stellen: projo-Schritt einschieben, falls nötig. */
export function finishAuthorization(res: Response, pending: PendingAuth, identity: AuthnIdentity): void {
  if (projoSessions.status(identity.email).connected) {
    completeAuthorization(res, pending, identity);
    return;
  }
  const id = randomToken(18);
  const clientName = getClient(pending.clientId)?.client_name;
  flows.set(id, { pending, identity, ...(clientName ? { clientName } : {}), expiresAt: Date.now() + FLOW_TTL_MS });
  log('info', 'Connect: projo-Schritt im OAuth-Ablauf', { email: identity.email, clientId: pending.clientId });
  res.redirect(302, `/connect?flow=${encodeURIComponent(id)}`);
}

/** Laufender Ablauf dieser Person (nur mit passender Identität). */
export function getFlow(id: string | undefined, email: string): { id: string; clientName?: string } | undefined {
  if (!id) return undefined;
  const f = flows.get(id);
  if (!f || f.expiresAt <= Date.now() || f.identity.email.toLowerCase() !== email.toLowerCase()) return undefined;
  return { id, ...(f.clientName ? { clientName: f.clientName } : {}) };
}

/** Ablauf abschließen: Authorization Code ausstellen und zum Client zurückleiten (einmalig). */
export function continueFlow(res: Response, id: string, email: string): boolean {
  const f = flows.get(id);
  if (!f || f.expiresAt <= Date.now() || f.identity.email.toLowerCase() !== email.toLowerCase()) return false;
  flows.delete(id);
  completeAuthorization(res, f.pending, f.identity);
  return true;
}
