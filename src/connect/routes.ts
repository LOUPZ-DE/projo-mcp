import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { activeIdps } from '../authn/idp/registry.js';
import { getSession, setSession } from '../authn/session.js';
import { users } from '../oauth/store.js';
import { isProjoError } from '../projo/errors.js';
import { audit, entraJobs, projoSessions } from '../projo/runtime.js';
import { renderErrorPage } from '../util/html.js';
import { log } from '../util/log.js';
import { continueFlow, getFlow } from './flow.js';
import { connectIdpCallback, connectIdpStart } from './idp.js';
import { ACTIVE_MS_STATES, connectPage, connectSignInPage } from './views.js';

/**
 * Verbindungsseite /connect: Hier (und nur hier) gibt eine Person ihre projo-Zugangsdaten ein.
 * Identität = Template-Login (`mcp_session`-Cookie aus dem OAuth-Connect oder Anmeldung direkt hier).
 */

export const connectRouter = Router();
const formParser = express.urlencoded({ extended: false, limit: '16kb' });

// ─── Helfer ──────────────────────────────────────────────────────────────────

/** CSRF-Token der Verbindungsseite: an die angemeldete Identität gebunden (HMAC mit SESSION_SECRET). */
export function connectCsrf(email: string): string {
  return createHmac('sha256', config.SESSION_SECRET).update(`connect-csrf:${email.toLowerCase()}`).digest('base64url');
}

function csrfOk(email: string, token: unknown): boolean {
  if (typeof token !== 'string') return false;
  const a = Buffer.from(token);
  const b = Buffer.from(connectCsrf(email));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Max. 5 Verbindungsversuche pro Person in 10 Minuten (schützt projo-Konten vor Durchprobieren). */
const attempts = new Map<string, number[]>();
function rateLimited(email: string): boolean {
  const now = Date.now();
  const list = (attempts.get(email) ?? []).filter((t) => t > now - 10 * 60_000);
  list.push(now);
  attempts.set(email, list);
  return list.length > 5;
}

function noStore(res: Response): Response {
  return res.set('Cache-Control', 'no-store').set('X-Frame-Options', 'DENY').set('Referrer-Policy', 'no-referrer');
}

/** flow-Kennung aus Query oder Formular (Connector-Ablauf „Schritt 2 von 2“). */
function flowIdOf(req: Request): string | undefined {
  const fromBody = (req.body as Record<string, unknown> | undefined)?.flow;
  const v = typeof fromBody === 'string' ? fromBody : req.query.flow;
  return typeof v === 'string' && v ? v : undefined;
}

/** Ziel nach einer Aktion: im Connector-Ablauf zurück auf dessen Seite, sonst /connect (+ Meldung). */
function nextUrl(req: Request, email: string, msg?: string): string {
  const flow = getFlow(flowIdOf(req), email);
  if (flow) return `/connect?flow=${encodeURIComponent(flow.id)}`;
  return msg ? `/connect?msg=${msg}` : '/connect';
}

function renderConnect(req: Request, res: Response, email: string, extra: { error?: string; status?: number } = {}): void {
  const msg = typeof req.query.msg === 'string' ? req.query.msg : undefined;
  const flow = getFlow(flowIdOf(req), email);
  noStore(res)
    .status(extra.status ?? 200)
    .send(
      connectPage({
        email,
        status: projoSessions.status(email),
        csrf: connectCsrf(email),
        msg,
        error: extra.error,
        allowStorePassword: config.PROJO_STORE_PASSWORDS,
        microsoftAvailable: config.PROJO_MS_CONNECT,
        msJob: entraJobs.status(email),
        ...(flow ? { flow } : {}),
      }),
    );
}

function renderSignIn(res: Response, error?: string, status = 200): void {
  noStore(res)
    .status(status)
    .send(connectSignInPage({ idps: activeIdps.map((p) => ({ key: p.key, displayName: p.displayName })), localEnabled: config.localEnabled, error }));
}

// ─── Routen ──────────────────────────────────────────────────────────────────

connectRouter.get('/connect', (req, res) => {
  const session = getSession(req);
  if (!session) return renderSignIn(res);
  // Connector-Ablauf: ist projo (inzwischen) verbunden und keine Anmeldung mehr aktiv → zurück zum Client
  const flow = getFlow(flowIdOf(req), session.email);
  const job = entraJobs.status(session.email);
  if (flow && projoSessions.status(session.email).connected && !(job && ACTIVE_MS_STATES.has(job.state))) {
    res.redirect(303, `/connect/flow/${encodeURIComponent(flow.id)}/continue`);
    return;
  }
  renderConnect(req, res, session.email);
});

/** Connector-Ablauf abschließen (nach dem Verbinden oder per „Überspringen“): Code ausstellen, zurück zum Client. */
connectRouter.get('/connect/flow/:id/continue', (req, res) => {
  const session = getSession(req);
  if (!session) return renderSignIn(res);
  noStore(res);
  if (!continueFlow(res, String(req.params.id), session.email)) {
    renderErrorPage(res, 400, 'Ablauf abgelaufen', 'Die Anmeldung beim KI-Assistenten ist abgelaufen – bitte den Connector dort erneut verbinden.');
  }
});

connectRouter.post('/connect/password', formParser, async (req, res) => {
  const session = getSession(req);
  if (!session) return renderSignIn(res, 'Bitte zuerst anmelden.', 401);
  const body = req.body as Record<string, unknown>;
  if (!csrfOk(session.email, body.csrf)) return renderConnect(req, res, session.email, { error: 'Sitzung der Seite abgelaufen – bitte erneut versuchen.', status: 403 });
  const projoEmail = typeof body.projo_email === 'string' ? body.projo_email.trim() : '';
  const password = typeof body.projo_password === 'string' ? body.projo_password : '';
  if (!projoEmail || !password) return renderConnect(req, res, session.email, { error: 'Bitte projo-E-Mail und Passwort angeben.', status: 400 });
  if (rateLimited(session.email)) return renderConnect(req, res, session.email, { error: 'Zu viele Versuche – bitte in einigen Minuten erneut probieren.', status: 429 });

  try {
    await projoSessions.connectWithPassword(session.email, projoEmail, password, body.store_password === '1');
    audit.write({ user: session.email, action: 'connect.password', result: 'ok', details: { projoEmail, storePassword: body.store_password === '1' } });
    res.redirect(303, nextUrl(req, session.email, 'connected'));
  } catch (err) {
    const message = isProjoError(err) ? err.message : 'Unerwarteter Fehler beim Verbinden.';
    audit.write({ user: session.email, action: 'connect.password', result: 'error', details: { projoEmail }, error: isProjoError(err) ? err.code : 'error' });
    if (!isProjoError(err)) log('error', 'Connect: Passwort-Login fehlgeschlagen', { error: err instanceof Error ? err.message : String(err) });
    renderConnect(req, res, session.email, { error: message, status: 400 });
  }
});

connectRouter.post('/connect/disconnect', formParser, async (req, res) => {
  const session = getSession(req);
  if (!session) return renderSignIn(res, 'Bitte zuerst anmelden.', 401);
  if (!csrfOk(session.email, (req.body as Record<string, unknown>).csrf)) {
    return renderConnect(req, res, session.email, { error: 'Sitzung der Seite abgelaufen – bitte erneut versuchen.', status: 403 });
  }
  const removed = await projoSessions.disconnect(session.email);
  audit.write({ user: session.email, action: 'disconnect', result: 'ok', details: { removed } });
  res.redirect(303, '/connect?msg=disconnected');
});

// ─── Microsoft („Mit Microsoft anmelden“ bei projo, ausgeführt im Server-Browser) ───────────

connectRouter.post('/connect/microsoft', formParser, (req, res) => {
  const session = getSession(req);
  if (!session) return renderSignIn(res, 'Bitte zuerst anmelden.', 401);
  if (!config.PROJO_MS_CONNECT) return renderConnect(req, res, session.email, { error: 'Die Microsoft-Anmeldung ist auf diesem Server deaktiviert.', status: 400 });
  const body = req.body as Record<string, unknown>;
  if (!csrfOk(session.email, body.csrf)) return renderConnect(req, res, session.email, { error: 'Sitzung der Seite abgelaufen – bitte erneut versuchen.', status: 403 });
  const msEmail = typeof body.ms_email === 'string' ? body.ms_email.trim() : '';
  const msPassword = typeof body.ms_password === 'string' ? body.ms_password : '';
  if (!/^[^\s@]+@[^\s@]+$/.test(msEmail)) return renderConnect(req, res, session.email, { error: 'Bitte das Microsoft-Konto (E-Mail) angeben.', status: 400 });
  if (rateLimited(session.email)) return renderConnect(req, res, session.email, { error: 'Zu viele Versuche – bitte in einigen Minuten erneut probieren.', status: 429 });
  entraJobs.start(session.email, msEmail, msPassword);
  // eindeutige URL → der Browser lädt garantiert frisch (kein Wiederverwenden der Formularseite)
  const flow = getFlow(flowIdOf(req), session.email);
  res.redirect(303, `/connect?ms=${Date.now().toString(36)}${flow ? `&flow=${encodeURIComponent(flow.id)}` : ''}`);
});

/** Status der laufenden Microsoft-Anmeldung (für die Anzeige auf der Verbindungsseite, wird gepollt). */
connectRouter.get('/connect/status', (req, res) => {
  const session = getSession(req);
  noStore(res);
  if (!session) {
    res.status(401).json({ state: 'none' });
    return;
  }
  res.json(entraJobs.status(session.email) ?? { state: 'none' });
});

/** Bestätigungscode (TOTP/SMS/E-Mail) an die laufende Anmeldung übergeben. */
connectRouter.post('/connect/mfa', formParser, (req, res) => {
  const session = getSession(req);
  noStore(res);
  const asJson = req.is('application/json') === 'application/json';
  const body = (req.body ?? {}) as Record<string, unknown>;
  const reply = (status: number, payload: Record<string, unknown>) => (asJson ? res.status(status).json(payload) : res.redirect(303, '/connect'));
  if (!session || !csrfOk(session.email, body.csrf)) return reply(403, { ok: false });
  const code = typeof body.code === 'string' ? body.code.replace(/\s+/g, '') : '';
  if (!/^\d{4,10}$/.test(code)) return reply(400, { ok: false, error: 'Der Code besteht aus 4–10 Ziffern.' });
  return reply(200, { ok: entraJobs.submitCode(session.email, code) });
});

connectRouter.post('/connect/microsoft/cancel', formParser, (req, res) => {
  const session = getSession(req);
  if (!session) return renderSignIn(res, 'Bitte zuerst anmelden.', 401);
  if (csrfOk(session.email, (req.body as Record<string, unknown>).csrf)) entraJobs.cancel(session.email);
  res.redirect(303, nextUrl(req, session.email));
});

// Anmeldung an diesem Server direkt hier (falls kein mcp_session-Cookie vorhanden)
connectRouter.post('/connect/login', formParser, (req, res) => {
  if (!config.localEnabled) return renderSignIn(res, 'Lokale Anmeldung ist deaktiviert.', 400);
  const body = req.body as Record<string, unknown>;
  const email = typeof body.email === 'string' ? body.email.toLowerCase() : '';
  const user = users.get(email);
  if (!user || user.password !== body.password) return renderSignIn(res, 'E-Mail oder Passwort falsch.', 401);
  setSession(res, { email: user.email, name: user.name, idp: 'local' });
  res.redirect(303, '/connect');
});

connectRouter.get('/connect/auth/:provider/start', connectIdpStart);
connectRouter.get('/connect/auth/:provider/callback', (req, res, next) => {
  void connectIdpCallback(req, res).catch(next);
});
