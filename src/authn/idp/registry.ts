import { config } from '../../config.js';
import { log } from '../../util/log.js';
import type { IdpProvider } from './types.js';
import { googleProvider, entraProvider } from './providers.js';

/** Aktive externe Identity Provider — aus AUTH_PROVIDERS + Provider-Envs gebaut. */
export const activeIdps: IdpProvider[] = [];

if (config.AUTH_PROVIDERS.includes('google')) {
  activeIdps.push(googleProvider(config.GOOGLE_CLIENT_ID!, config.GOOGLE_CLIENT_SECRET!));
}
if (config.AUTH_PROVIDERS.includes('entra')) {
  activeIdps.push(entraProvider(config.ENTRA_TENANT_ID!, config.ENTRA_CLIENT_ID!, config.ENTRA_CLIENT_SECRET!));
}

if (activeIdps.length > 0) {
  log('info', 'SSO-Provider aktiv', { providers: activeIdps.map((p) => p.key) });
  if (config.SSO_ALLOWED_DOMAINS.length === 0 && config.SSO_ALLOWED_EMAILS.length === 0) {
    log('warn', 'SSO ist OHNE Allowlist aktiv — JEDER Account des IdP kann sich einloggen. SSO_ALLOWED_DOMAINS oder SSO_ALLOWED_EMAILS setzen!');
  }
}

export function getIdp(key: string): IdpProvider | undefined {
  return activeIdps.find((p) => p.key === key);
}

/** Allowlist-Prüfung für SSO-Logins (offen, wenn nichts konfiguriert — s. Warnung oben). */
export function isEmailAllowed(email: string): boolean {
  const { SSO_ALLOWED_DOMAINS, SSO_ALLOWED_EMAILS } = config;
  if (SSO_ALLOWED_DOMAINS.length === 0 && SSO_ALLOWED_EMAILS.length === 0) return true;
  const lower = email.toLowerCase();
  if (SSO_ALLOWED_EMAILS.includes(lower)) return true;
  const domain = lower.split('@')[1];
  return !!domain && SSO_ALLOWED_DOMAINS.includes(domain);
}
