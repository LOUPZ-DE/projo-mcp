import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { config } from '../config.js';

const key = new TextEncoder().encode(config.TOKEN_SECRET);

export interface AccessTokenClaims {
  email: string;
  name: string;
  clientId: string;
  scope?: string;
  resource?: string;
  /** Notion schickt beim Authorize-Request eine notion_user_id mit — landet als Custom Claim im JWT. */
  notionUserId?: string;
  /** Herkunft der Identität: 'local' | 'google' | 'entra' */
  idp?: string;
}

/** Access Token = JWT (HS256) — self-contained, wird serverseitig nicht gespeichert. */
export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    email: claims.email,
    name: claims.name,
    client_id: claims.clientId,
    scope: claims.scope ?? 'mcp',
    ...(claims.notionUserId ? { notion_user_id: claims.notionUserId } : {}),
    ...(claims.idp ? { idp: claims.idp } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setIssuer(config.BASE_URL)
    .setAudience(config.MCP_RESOURCE)
    .setSubject(claims.email)
    .setJti(randomUUID())
    .setExpirationTime(now + config.ACCESS_TOKEN_TTL)
    .sign(key);
}

/**
 * Verifier für die SDK-Middleware `requireBearerAuth`.
 * Wirft InvalidTokenError → Middleware mapped auf 401 mit WWW-Authenticate-Header.
 */
export class JwtVerifier implements OAuthTokenVerifier {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let payload;
    try {
      const result = await jwtVerify(token, key, {
        algorithms: ['HS256'],
        issuer: config.BASE_URL,
        audience: config.MCP_RESOURCE,
      });
      payload = result.payload;
    } catch (err) {
      throw new InvalidTokenError(`Token ungültig: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof payload.exp !== 'number') {
      throw new InvalidTokenError('Token hat kein exp-Claim');
    }
    return {
      token,
      clientId: (payload.client_id as string) ?? 'unknown',
      scopes: typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [],
      expiresAt: payload.exp,
      resource: new URL(config.MCP_RESOURCE),
      extra: {
        email: (payload.email as string) ?? payload.sub,
        name: payload.name as string | undefined,
        notionUserId: payload.notion_user_id as string | undefined,
        idp: payload.idp as string | undefined,
      },
    };
  }
}
