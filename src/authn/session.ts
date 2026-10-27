import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import type { AuthnIdentity } from './identity.js';

const COOKIE_NAME = 'mcp_session';

interface SessionData extends AuthnIdentity {
  exp: number; // unix seconds
}

function sign(payloadB64: string): string {
  return createHmac('sha256', config.SESSION_SECRET).update(payloadB64).digest('base64url');
}

/**
 * Dependency-free signiertes Session-Cookie.
 * Payload: base64url(JSON{email, name, idp, exp}) + '.' + HMAC(payload)
 * → funktioniert für lokale User UND SSO-Identitäten (kein User-Store nötig).
 */
export function setSession(res: Response, identity: AuthnIdentity): void {
  const data: SessionData = {
    ...identity,
    exp: Math.floor(Date.now() / 1000) + config.REFRESH_TOKEN_TTL,
  };
  const payloadB64 = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  const value = `${payloadB64}.${sign(payloadB64)}`;
  const parts = [
    `${COOKIE_NAME}=${value}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${config.REFRESH_TOKEN_TTL}`,
  ];
  // Secure nur bei HTTPS — sonst würde der Browser das Cookie im lokalen HTTP-Dev verwerfen.
  if (config.isHttps) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function getSession(req: Request): AuthnIdentity | undefined {
  const header = req.get('cookie');
  if (!header) return undefined;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== COOKIE_NAME) continue;
    const value = pair.slice(eq + 1).trim();
    const lastDot = value.lastIndexOf('.');
    if (lastDot === -1) return undefined;
    const payloadB64 = value.slice(0, lastDot);
    const sig = value.slice(lastDot + 1);
    const expected = sign(payloadB64);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
    try {
      const data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as SessionData;
      if (!Number.isFinite(data.exp) || data.exp <= Math.floor(Date.now() / 1000)) return undefined;
      if (typeof data.email !== 'string' || typeof data.name !== 'string' || typeof data.idp !== 'string') return undefined;
      return { email: data.email, name: data.name, idp: data.idp };
    } catch {
      return undefined;
    }
  }
  return undefined;
}
