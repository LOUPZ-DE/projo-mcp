import { config } from '../config.js';
import { AuditLog } from './audit.js';
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
