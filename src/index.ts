import express, { type NextFunction, type Request, type Response } from 'express';
import { readFileSync } from 'node:fs';
import cors from 'cors';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { config } from './config.js';
import { log, requestLogger } from './util/log.js';
import { escapeHtml, widePage } from './util/html.js';
import { loadState } from './oauth/store.js';
import { JwtVerifier } from './oauth/jwt.js';
import { prmHandler, asMetadataHandler } from './oauth/metadata.js';
import { registerHandler } from './oauth/register.js';
import { authorizeGetHandler, authorizePostHandler } from './oauth/authorize.js';
import { tokenHandler } from './oauth/token.js';
import { idpStartHandler, idpCallbackHandler } from './authn/idp/routes.js';
import { mcpPostHandler, mcpMethodNotAllowedHandler } from './mcp/server.js';

loadState();

const app = express();
app.set('trust proxy', 1); // Traefik/EasyPanel terminiert TLS

// 1) Logging zuerst — auch abgelehnte Requests sollen im Log auftauchen.
app.use(requestLogger);

// 2) Body-Parser: JSON global (MCP + DCR), urlencoded nur für /authorize POST + /token.
app.use(express.json({ limit: '1mb' }));
const formParser = express.urlencoded({ extended: false, limit: '64kb' });

// 3) CORS für browser-basierte Clients (MCP Inspector). Notion selbst ruft serverseitig ab.
const corsMiddleware = cors({
  origin: true,
  allowedHeaders: ['Authorization', 'Content-Type', 'MCP-Protocol-Version', 'Mcp-Session-Id'],
  exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
});

// 4) Routen
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Server-Icon (wird von /.well-known/mcp.json und serverInfo.icons referenziert)
const iconPng = readFileSync(new URL('../assets/icon.png', import.meta.url));
app.get('/icon.png', (_req, res) => {
  res.set('Content-Type', 'image/png').set('Cache-Control', 'public, max-age=86400').send(iconPng);
});

// Notion-Konvention: Discovery-Dokument für MCP-Clients (Name, Beschreibung, Icon).
// Notion ruft diese Datei beim Verbinden tatsächlich ab (sichtbar im Request-Log).
app.get('/.well-known/mcp.json', corsMiddleware, (_req, res) => {
  res
    .set('Cache-Control', 'public, max-age=300')
    .json({
      name: config.SERVER_NAME,
      description: `${config.SERVER_NAME} — MCP-Server mit OAuth 2.1 + DCR (Referenz-Implementierung)`,
      icon: `${config.BASE_URL}/icon.png`,
      endpoint: config.MCP_RESOURCE,
    });
});

// RFC 9728 PRM — Root-Variante (Notions Discovery) + pfad-spezifische Variante (RFC 9728 §3.1)
app.get('/.well-known/oauth-protected-resource', corsMiddleware, prmHandler);
app.get('/.well-known/oauth-protected-resource/mcp', corsMiddleware, prmHandler);

// RFC 8414 AS-Metadata (+ OIDC-Alias, manche Clients probieren den)
app.get('/.well-known/oauth-authorization-server', corsMiddleware, asMetadataHandler);
app.get('/.well-known/openid-configuration', corsMiddleware, asMetadataHandler);

// RFC 7591 DCR
app.post('/register', corsMiddleware, registerHandler);

// Authorization Endpoint (Browser-Flow — Login-Rendering in src/authn/, austauschbar)
app.get('/authorize', authorizeGetHandler);
app.post('/authorize', formParser, authorizePostHandler);

// SSO: OIDC-Flow zu externen Identity Providern (aktive Provider siehe AUTH_PROVIDERS)
app.get('/auth/:provider/start', idpStartHandler);
app.get('/auth/:provider/callback', idpCallbackHandler);

// Token Endpoint
app.post('/token', corsMiddleware, formParser, tokenHandler);

// MCP Endpoint — Bearer-Middleware VOR dem 405-Handler, damit jede Methode unauthentifiziert 401 liefert.
// MCP läuft bewusst NUR auf /mcp (keine Root-Auslieferung): Auf einem Host, der auch eine
// herkömmliche API bedient, muss der MCP-Endpunkt ein eigener Pfad bleiben. In Notion muss
// der Connector daher mit der vollen URL inkl. /mcp eingetragen werden — Notion verwendet die
// eingegebene URL als Endpunkt für den gesamten MCP-Traffic.
const bearerAuth = requireBearerAuth({
  verifier: new JwtVerifier(),
  resourceMetadataUrl: config.PRM_URL,
});
app.all('/mcp', corsMiddleware, bearerAuth, (req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'POST') {
    void mcpPostHandler(req, res).catch(next);
  } else {
    mcpMethodNotAllowedHandler(req, res);
  }
});

// Info-Seite auf / (HTML, wie im image-ai-portal-Pattern): zeigt Status, Endpunkte
// und die korrekte Connector-URL (verhindert den Root-URL-Fehltritt in Notion).
app.get('/', (_req, res) => {
  const body = `
    <h1>${escapeHtml(config.SERVER_NAME)}</h1>
    <div class="sub">Remote-MCP-Server mit OAuth 2.1 + Dynamic Client Registration (Test)</div>
    <table>
      <tr><td>MCP-Endpoint</td><td><span class="url">${escapeHtml(config.MCP_RESOURCE)}</span></td></tr>
      <tr><td>PRM (RFC 9728)</td><td><a href="${escapeHtml(config.PRM_URL)}">${escapeHtml(config.PRM_URL)}</a></td></tr>
      <tr><td>AS-Metadata (RFC 8414)</td><td><a href="${escapeHtml(config.BASE_URL)}/.well-known/oauth-authorization-server">${escapeHtml(config.BASE_URL)}/.well-known/oauth-authorization-server</a></td></tr>
      <tr><td>DCR (RFC 7591)</td><td><span class="url">POST ${escapeHtml(config.BASE_URL)}/register</span></td></tr>
      <tr><td>Health</td><td><a href="/health">/health</a></td></tr>
    </table>
    <div class="meta">
      In Notion als Custom MCP Server die <b>MCP-Endpoint-URL inkl. /mcp</b> eintragen —
      Notion verwendet die eingegebene URL als Endpunkt für den gesamten MCP-Traffic.
      Tools: <code>whoami</code> · <code>echo</code> · <code>slow_task</code>
    </div>`;
  res.set('Cache-Control', 'no-store').status(200).send(widePage('Info', body));
});

// 5) 404 + zentraler Error-Handler
app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log('error', 'Unbehandelter Fehler', { error: err instanceof Error ? err.message : String(err) });
  if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
});

app.listen(config.PORT, () => {
  log('info', `${config.SERVER_NAME} läuft`, {
    port: config.PORT,
    baseUrl: config.BASE_URL,
    mcpResource: config.MCP_RESOURCE,
    accessTokenTtl: config.ACCESS_TOKEN_TTL,
    authProviders: config.AUTH_PROVIDERS,
    users: config.USERS.length,
    stateFile: config.STATE_FILE ?? '(in-memory)',
  });
});
