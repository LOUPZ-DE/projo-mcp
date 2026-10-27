import { createRemoteJWKSet, type JWTPayload } from 'jose';
import type { IdpProvider } from './types.js';

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Google — einfachster OIDC-Provider.
 * Setup: Google Cloud Console → APIs & Services → Credentials →
 * „OAuth 2.0 Client ID" (Web) → Authorized redirect URI:
 *   https://<host>/auth/google/callback
 */
export function googleProvider(clientId: string, clientSecret: string): IdpProvider {
  return {
    key: 'google',
    displayName: 'Google',
    // Google hat historisch beide iss-Varianten ausgestellt
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    jwks: createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs')),
    clientId,
    clientSecret,
    scope: 'openid email profile',
    mapClaims(claims: JWTPayload) {
      if (claims.email_verified === false) return null;
      const email = asString(claims.email);
      if (!email) return null;
      return {
        providerKey: 'google',
        subject: asString(claims.sub) ?? '',
        email,
        name: asString(claims.name) ?? email,
        raw: claims,
      };
    },
  };
}

/**
 * Microsoft Entra ID — Single-Tenant (empfohlen: die Tenant-Bindung IST die
 * Org-Beschränkung, Issuer ist auf den Tenant gepinnt).
 * Setup: Entra Portal → App registrations → New registration →
 *   „Accounts in this organizational directory only (Single tenant)" →
 *   Redirect URI (Web): https://<host>/auth/entra/callback →
 *   Certificates & secrets → New client secret.
 * Achtung Claims: `email` ist NICHT garantiert (mailbox-abhängig) → Fallback-Kette.
 */
export function entraProvider(tenantId: string, clientId: string, clientSecret: string): IdpProvider {
  const base = `https://login.microsoftonline.com/${tenantId}`;
  return {
    key: 'entra',
    displayName: 'Microsoft',
    issuer: `${base}/v2.0`,
    authorizationEndpoint: `${base}/oauth2/v2.0/authorize`,
    tokenEndpoint: `${base}/oauth2/v2.0/token`,
    jwks: createRemoteJWKSet(new URL(`${base}/discovery/v2.0/keys`)),
    clientId,
    clientSecret,
    scope: 'openid email profile',
    mapClaims(claims: JWTPayload) {
      const email = [claims.email, claims.preferred_username, claims.upn].map(asString).find(Boolean);
      if (!email) return null;
      return {
        providerKey: 'entra',
        subject: asString(claims.sub) ?? asString(claims.oid) ?? '',
        email,
        name: asString(claims.name) ?? email,
        raw: claims,
      };
    },
  };
}
