import { join } from 'node:path';
import { z } from 'zod';

const userSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  name: z.string().min(1),
});

const csvList = (s: string) =>
  [...new Set(s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))];

/** "true"/"false"/"1"/"0"/"yes"/"no" → boolean, mit Default bei fehlender Variable. */
const boolish = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true' || v === '1' || v === 'yes'));

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  BASE_URL: z
    .string()
    .url()
    .transform((u) => u.replace(/\/+$/, '')),
  TOKEN_SECRET: z.string().min(32, 'TOKEN_SECRET muss mindestens 32 Zeichen haben'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET muss mindestens 32 Zeichen haben'),
  // Optional seit SSO: nur Pflicht, wenn 'local' in AUTH_PROVIDERS (siehe Post-Validierung unten)
  USERS_JSON: z.string().optional(),
  ACCESS_TOKEN_TTL: z.coerce.number().int().min(5).default(3600),
  REFRESH_TOKEN_TTL: z.coerce.number().int().min(60).default(2592000),
  STATE_FILE: z.string().min(1).optional(),

  // Anzeigename des Servers (serverInfo.name, mcp.json, PRM resource_name, HTML-Seiten)
  SERVER_NAME: z.string().min(1).default('projo-mcp'),

  // ─── Authentication Provider ────────────────────────────────────────────
  // Komma-separierte Liste: local | google | entra (mehrere gleichzeitig möglich)
  AUTH_PROVIDERS: z.string().default('local').transform(csvList),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  ENTRA_TENANT_ID: z.string().optional(),
  // Allowlist für SSO (beide optional; wenn beide leer → Warnung beim Boot, offener Login)
  SSO_ALLOWED_DOMAINS: z.string().optional().transform((s) => (s ? csvList(s) : [])),
  SSO_ALLOWED_EMAILS: z.string().optional().transform((s) => (s ? csvList(s) : [])),

  // ─── projo ──────────────────────────────────────────────────────────────
  PROJO_BASE_URL: z
    .string()
    .url()
    .default('https://my.projo.berlin')
    .transform((u) => u.replace(/\/+$/, '')),
  // Datenverzeichnis: Sitzungs-Tresor (vault/), Audit-Log. Docker: /data
  DATA_DIR: z.string().min(1).default('./data'),
  // Schlüssel des Sitzungs-Tresors (AES-256-GCM), genau 32 Byte base64
  VAULT_KEY: z
    .string({ error: 'VAULT_KEY fehlt – erzeugen mit: openssl rand -base64 32' })
    .refine((s) => Buffer.from(s, 'base64').length === 32, 'VAULT_KEY muss genau 32 Byte (base64) lang sein – erzeugen mit: openssl rand -base64 32'),
  // Opt-in-Speicherung des projo-Passworts (nur Passwort-Login) für stille Neuanmeldung anbieten
  PROJO_STORE_PASSWORDS: boolish(true),
  // Microsoft-Cookies nach SSO-Connect behalten (stille SSO-Neuanmeldung, größere Angriffsfläche)
  PROJO_KEEP_MS_COOKIES: boolish(false),
  PROJO_USER_AGENT: z.string().min(1).optional(),
  // Verbundene Sitzungen alle N Stunden auffrischen (projo verlängert sein Cookie rollierend); 0 = aus
  KEEPALIVE_HOURS: z.coerce.number().min(0).default(24),
  SESSION_IDLE_MS: z.coerce.number().int().min(10_000).default(15 * 60_000),
  BROWSER_IDLE_MS: z.coerce.number().int().min(10_000).default(5 * 60_000),
  BROWSER_MAX_CONTEXTS: z.coerce.number().int().min(1).max(20).default(3),

  // ─── Optionaler LLM-Router (Ausweich-Extraktion, Reparaturvorschläge) ───
  REQUESTY_API_KEY: z.string().min(1).optional(),
  REQUESTY_BASE_URL: z.string().url().default('https://router.eu.requesty.ai/v1'),
  REQUESTY_MODEL: z.string().min(1).optional(),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Ungültige Konfiguration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

function fail(msg: string): never {
  console.error(`❌ Ungültige Konfiguration: ${msg}`);
  process.exit(1);
}

const env = parsed.data;

// ─── Post-Validierung: Provider-Abhängigkeiten ─────────────────────────────

const KNOWN_PROVIDERS = ['local', 'google', 'entra'];
for (const p of env.AUTH_PROVIDERS) {
  if (!KNOWN_PROVIDERS.includes(p)) {
    fail(`AUTH_PROVIDERS enthält unbekannten Provider '${p}' (erlaubt: ${KNOWN_PROVIDERS.join(', ')})`);
  }
}

const localEnabled = env.AUTH_PROVIDERS.includes('local');

let users: z.infer<typeof userSchema>[] = [];
if (env.USERS_JSON) {
  try {
    users = z.array(userSchema).parse(JSON.parse(env.USERS_JSON));
  } catch (err) {
    fail(`USERS_JSON ist ungültig: ${err instanceof Error ? err.message : String(err)}`);
  }
}
if (localEnabled && users.length === 0) {
  fail("AUTH_PROVIDERS enthält 'local', aber USERS_JSON fehlt oder ist leer");
}

if (env.AUTH_PROVIDERS.includes('google') && (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)) {
  fail("AUTH_PROVIDERS enthält 'google', aber GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET fehlen");
}
if (env.AUTH_PROVIDERS.includes('entra') && (!env.ENTRA_CLIENT_ID || !env.ENTRA_CLIENT_SECRET || !env.ENTRA_TENANT_ID)) {
  fail("AUTH_PROVIDERS enthält 'entra', aber ENTRA_CLIENT_ID/ENTRA_CLIENT_SECRET/ENTRA_TENANT_ID fehlen");
}

if (env.REQUESTY_API_KEY && !env.REQUESTY_MODEL) {
  fail('REQUESTY_API_KEY ist gesetzt, aber REQUESTY_MODEL fehlt (z. B. eine Routing-Policy wie policy/projo-heal)');
}

const isHttps = env.BASE_URL.startsWith('https://');
const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(env.BASE_URL);

if (!isHttps && !isLocalhost) {
  console.warn(`⚠️  BASE_URL (${env.BASE_URL}) ist kein HTTPS und kein localhost — Notion wird den Server nicht akzeptieren.`);
}

export const config = Object.freeze({
  ...env,
  USERS: users,
  localEnabled,
  /** Öffentliche URL der MCP-Resource (RFC 8707 resource indicator) */
  MCP_RESOURCE: `${env.BASE_URL}/mcp`,
  /** Öffentliche URL des PRM-Dokuments */
  PRM_URL: `${env.BASE_URL}/.well-known/oauth-protected-resource`,
  isHttps,
  /** Verbindungsseite für das projo-Konto (Link in Tool-Antworten) */
  CONNECT_URL: `${env.BASE_URL}/connect`,
  VAULT_DIR: join(env.DATA_DIR, 'vault'),
  AUDIT_FILE: join(env.DATA_DIR, 'audit.log'),
  harnessEnabled: Boolean(env.REQUESTY_API_KEY),
});
