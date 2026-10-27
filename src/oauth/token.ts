import type { Request, Response } from 'express';
import { randomToken, verifyS256 } from './pkce.js';
import { authCodes, getAuthCode, getRefreshToken, refreshTokens, scheduleSave } from './store.js';
import { signAccessToken } from './jwt.js';
import { config } from '../config.js';
import { log } from '../util/log.js';

function firstParam(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

/** RFC 6749 §5.1: no-store/no-cache auf Erfolg UND Fehler. */
function tokenJson(res: Response, status: number, body: Record<string, unknown>): void {
  res
    .set('Cache-Control', 'no-store')
    .set('Pragma', 'no-cache')
    .status(status)
    .json(body);
}

function tokenError(res: Response, error: string, description: string): void {
  tokenJson(res, 400, { error, error_description: description });
}

async function issueTokenPair(res: Response, params: {
  clientId: string; email: string; name: string; scope?: string; resource?: string; notionUserId?: string; idp?: string;
}): Promise<void> {
  const accessToken = await signAccessToken({
    email: params.email,
    name: params.name,
    clientId: params.clientId,
    scope: params.scope,
    resource: params.resource,
    notionUserId: params.notionUserId,
    idp: params.idp,
  });
  const refreshToken = randomToken(32);
  refreshTokens.set(refreshToken, {
    clientId: params.clientId,
    email: params.email,
    name: params.name,
    scope: params.scope,
    resource: params.resource,
    notionUserId: params.notionUserId,
    idp: params.idp,
    expiresAt: Date.now() + config.REFRESH_TOKEN_TTL * 1000,
  });
  scheduleSave();
  const scope = params.scope ?? 'mcp';
  tokenJson(res, 200, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: config.ACCESS_TOKEN_TTL,
    refresh_token: refreshToken,
    scope,
  });
}

/**
 * POST /token — application/x-www-form-urlencoded (OAuth-Clients senden hier nie JSON).
 * Grants: authorization_code (mit PKCE S256) + refresh_token (mit Rotation).
 */
export async function tokenHandler(req: Request, res: Response): Promise<void> {
  if (!req.is('application/x-www-form-urlencoded')) {
    tokenError(res, 'invalid_request', 'Content-Type muss application/x-www-form-urlencoded sein');
    return;
  }

  const body = req.body as Record<string, unknown>;
  const grantType = firstParam(body.grant_type);
  const clientId = firstParam(body.client_id);
  const resource = firstParam(body.resource);

  if (resource && resource !== config.MCP_RESOURCE) {
    log('warn', 'Token: resource-Param weicht von MCP_RESOURCE ab', { resource, expected: config.MCP_RESOURCE, grantType });
  }

  if (grantType === 'authorization_code') {
    const code = firstParam(body.code);
    const redirectUri = firstParam(body.redirect_uri);
    const codeVerifier = firstParam(body.code_verifier);
    if (!code || !clientId || !redirectUri || !codeVerifier) {
      tokenError(res, 'invalid_request', 'code, client_id, redirect_uri und code_verifier sind erforderlich');
      return;
    }

    // Code single-use: sofort löschen, BEVOR irgendetwas anderes validiert wird.
    const stored = getAuthCode(code);
    authCodes.delete(code);
    if (!stored) {
      tokenError(res, 'invalid_grant', 'Authorization code unbekannt oder abgelaufen');
      return;
    }
    if (stored.clientId !== clientId) {
      tokenError(res, 'invalid_grant', 'client_id passt nicht zum authorization code');
      return;
    }
    if (stored.redirectUri !== redirectUri) {
      tokenError(res, 'invalid_grant', 'redirect_uri weicht vom authorize-Request ab');
      return;
    }
    if (!verifyS256(codeVerifier, stored.codeChallenge)) {
      log('info', 'Token: PKCE-Verifizierung fehlgeschlagen', { clientId });
      tokenError(res, 'invalid_grant', 'PKCE-Verifizierung fehlgeschlagen');
      return;
    }

    log('info', 'Token: code-Grant erfolgreich', { clientId, email: stored.email, scope: stored.scope });
    await issueTokenPair(res, {
      clientId,
      email: stored.email,
      name: stored.name,
      scope: stored.scope,
      resource: stored.resource,
      notionUserId: stored.notionUserId,
      idp: stored.idp,
    });
    return;
  }

  if (grantType === 'refresh_token') {
    const refreshToken = firstParam(body.refresh_token);
    if (!refreshToken || !clientId) {
      tokenError(res, 'invalid_request', 'refresh_token und client_id sind erforderlich');
      return;
    }
    const stored = getRefreshToken(refreshToken);
    if (!stored || stored.clientId !== clientId) {
      tokenError(res, 'invalid_grant', 'refresh_token unbekannt, abgelaufen oder passt nicht zum Client');
      return;
    }
    // Rotation: altes Token löschen, neues Paar ausstellen.
    refreshTokens.delete(refreshToken);
    log('info', 'Token: refresh-Grant erfolgreich (Rotation)', { clientId, email: stored.email });
    await issueTokenPair(res, {
      clientId,
      email: stored.email,
      name: stored.name,
      scope: stored.scope,
      resource: stored.resource,
      notionUserId: stored.notionUserId,
      idp: stored.idp,
    });
    return;
  }

  tokenError(res, 'unsupported_grant_type', `grant_type '${grantType ?? ''}' wird nicht unterstützt`);
}
