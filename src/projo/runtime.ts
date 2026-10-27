import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { config } from '../config.js';
import { log } from '../util/log.js';
import { AuditLog } from './audit.js';
import { EntraConnectJobs, silentSsoLogin } from './auth/entra.js';
import { BrowserPool } from './browser.js';
import { ProjoSessionManager } from './session.js';
import { Vault } from './vault.js';

/**
 * Prozessweite Singletons der projo-Schicht. Der MCP-Server wird pro Request neu gebaut –
 * alles, was über Requests hinweg leben muss (Sitzungen, Sperren, Tresor), hängt hier.
 */
export const vault = new Vault(config.VAULT_DIR, Buffer.from(config.VAULT_KEY, 'base64'));

export const audit = new AuditLog(config.AUDIT_FILE);

export const projoSessions = new ProjoSessionManager({
  vault,
  baseUrl: config.PROJO_BASE_URL,
  userAgent: config.PROJO_USER_AGENT,
  idleMs: config.SESSION_IDLE_MS,
  storePasswords: config.PROJO_STORE_PASSWORDS,
  keepMsCookies: config.PROJO_KEEP_MS_COOKIES,
});

/** Gemeinsames Chromium – nur für den Microsoft-Login bei projo. */
export const browserPool = new BrowserPool({ maxContexts: config.BROWSER_MAX_CONTEXTS, idleMs: config.BROWSER_IDLE_MS });

export const entraJobs = new EntraConnectJobs({
  pool: browserPool,
  sessions: projoSessions,
  baseUrl: config.PROJO_BASE_URL,
  keepMsCookies: config.PROJO_KEEP_MS_COOKIES,
  onFinish: (job) =>
    audit.write({
      user: job.mcpEmail,
      action: 'connect.microsoft',
      result: job.status.state === 'done' ? 'ok' : 'error',
      details: { projoEmail: job.msEmail },
      ...(job.status.state === 'done' ? {} : { error: job.status.message }),
    }),
});

if (config.PROJO_KEEP_MS_COOKIES) {
  projoSessions.setSilentSso((record) => silentSsoLogin({ pool: browserPool, baseUrl: config.PROJO_BASE_URL }, record));
}

/**
 * Startprüfung des Datenverzeichnisses: Tresor und OAuth-Zustand müssen dauerhaft und beschreibbar liegen.
 * Ein relativer Pfad im Container (z. B. DATA_DIR=./data) landet nicht im Volume → beim nächsten Deploy weg.
 */
export function assertDataDirUsable(): void {
  const inContainer = existsSync('/.dockerenv');
  const relative = [
    ['DATA_DIR', config.DATA_DIR],
    ['STATE_FILE', config.STATE_FILE],
  ].filter(([, v]) => v && !isAbsolute(v));
  if (inContainer && relative.length > 0) {
    log('error', 'Datenverzeichnis falsch konfiguriert', {
      hint: 'Im Container liegen relative Pfade nicht im Volume. DATA_DIR/STATE_FILE entfernen (Image setzt /data) oder absolut auf /data setzen.',
      relative: Object.fromEntries(relative),
    });
    process.exit(1);
  }
  try {
    mkdirSync(config.VAULT_DIR, { recursive: true, mode: 0o700 });
    const probe = join(config.VAULT_DIR, `.write-test-${process.pid}`);
    writeFileSync(probe, 'ok', { mode: 0o600 });
    rmSync(probe);
  } catch (err) {
    log('error', 'Datenverzeichnis nicht beschreibbar', { dataDir: config.DATA_DIR, error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}
