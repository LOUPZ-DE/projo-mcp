import type { Request, Response } from 'express';
import { z } from 'zod';
import { randomToken } from './pkce.js';
import { clients, scheduleSave, type RegisteredClient } from './store.js';
import { log } from '../util/log.js';

const redirectUriSchema = z.string().url().refine(
  (u) => {
    try {
      const url = new URL(u);
      if (url.protocol === 'https:') return true;
      // RFC 8252 Loopback-Exception: http nur auf localhost/127.0.0.1 (z. B. MCP Inspector)
      return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    } catch {
      return false;
    }
  },
  { message: 'redirect_uris müssen https sein (Ausnahme: http://localhost|127.0.0.1)' },
);

const clientMetadataSchema = z.object({
  redirect_uris: z.array(redirectUriSchema).min(1, 'mindestens eine redirect_uri erforderlich'),
  token_endpoint_auth_method: z.string().optional().default('none'),
  grant_types: z.array(z.string()).optional().default(['authorization_code']),
  response_types: z.array(z.string()).optional().default(['code']),
  client_name: z.string().optional(),
  client_uri: z.string().optional(),
  logo_uri: z.string().optional(),
  scope: z.string().optional(),
  contacts: z.array(z.string()).optional(),
  tos_uri: z.string().optional(),
  policy_uri: z.string().optional(),
}).loose(); // unbekannte Felder (software_id etc.) tolerieren — wir loggen sie ohnehin

function dcrError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

/**
 * RFC 7591 Dynamic Client Registration.
 * Antwortet mit 201 + client_id (public client — KEIN client_secret).
 * Der volle Request-Body wird vom requestLogger mitgeloggt (hier sehen wir,
 * welche redirect_uris Notion tatsächlich registriert).
 */
export function registerHandler(req: Request, res: Response): void {
  if (!req.is('application/json')) {
    dcrError(res, 415, 'invalid_client_metadata', 'Content-Type muss application/json sein');
    return;
  }

  const parsed = clientMetadataSchema.safeParse(req.body);
  if (!parsed.success) {
    dcrError(res, 400, 'invalid_client_metadata', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return;
  }
  const meta = parsed.data;

  if (meta.token_endpoint_auth_method !== 'none') {
    dcrError(res, 400, 'invalid_client_metadata', 'Nur public clients (token_endpoint_auth_method=none) werden unterstützt');
    return;
  }

  const client: RegisteredClient = {
    client_id: randomToken(24),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: meta.client_name,
    redirect_uris: meta.redirect_uris,
    grant_types: meta.grant_types,
    response_types: meta.response_types,
    token_endpoint_auth_method: 'none',
    scope: meta.scope,
  };
  clients.set(client.client_id, client);
  scheduleSave();

  log('info', 'DCR: neuer Client registriert', {
    client_id: client.client_id,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    scope: client.scope,
  });

  res.status(201).json({
    client_id: client.client_id,
    client_id_issued_at: client.client_id_issued_at,
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    grant_types: client.grant_types,
    response_types: client.response_types,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    ...(client.scope ? { scope: client.scope } : {}),
  });
}
