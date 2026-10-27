import type { Request, Response } from 'express';
import { config } from '../config.js';

const SCOPES = ['mcp'];

/**
 * RFC 9728 Protected Resource Metadata.
 * Wird sowohl an der Root-URL als auch an der pfad-spezifischen URL
 * (/.well-known/oauth-protected-resource/mcp, RFC 9728 §3.1) ausgeliefert.
 */
export function prmHandler(_req: Request, res: Response): void {
  res
    .set('Cache-Control', 'public, max-age=300')
    .json({
      resource: config.MCP_RESOURCE,
      authorization_servers: [config.BASE_URL],
      bearer_methods_supported: ['header'],
      scopes_supported: SCOPES,
      resource_name: config.SERVER_NAME,
    });
}

/**
 * RFC 8414 Authorization Server Metadata.
 * Zusätzlich unter /.well-known/openid-configuration erreichbar (manche Clients probieren das).
 * `issuer` muss zeichengenau BASE_URL entsprechen — Clients vergleichen per String.
 */
export function asMetadataHandler(_req: Request, res: Response): void {
  res
    .set('Cache-Control', 'public, max-age=300')
    .json({
      issuer: config.BASE_URL,
      authorization_endpoint: `${config.BASE_URL}/authorize`,
      token_endpoint: `${config.BASE_URL}/token`,
      registration_endpoint: `${config.BASE_URL}/register`,
      scopes_supported: SCOPES,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
    });
}
