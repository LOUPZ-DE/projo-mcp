import type { Response } from 'express';
import { config } from '../config.js';
import { escapeHtml, page } from '../util/html.js';
import { activeIdps } from './idp/registry.js';

export interface LoginPageOpts {
  txn: string;
  clientName?: string;
  scope?: string;
  error?: string;
}

/**
 * Login-Seite: SSO-Buttons für alle aktiven IdPs + optional das lokale Formular.
 * Wird neu gerendert (mit Fehlermeldung), wenn der lokale Login fehlschlägt.
 */
export function renderLoginPage(res: Response, opts: LoginPageOpts): void {
  const ssoButtons = activeIdps
    .map(
      (p) =>
        `<a class="sso-btn" href="/auth/${escapeHtml(p.key)}/start?txn=${encodeURIComponent(opts.txn)}">Mit ${escapeHtml(p.displayName)} anmelden</a>`,
    )
    .join('');

  const localForm = config.localEnabled
    ? `
    ${activeIdps.length > 0 ? '<div class="divider">oder</div>' : ''}
    <form method="post" action="/authorize" accept-charset="utf-8">
      <input type="hidden" name="txn" value="${escapeHtml(opts.txn)}">
      <label for="email">E-Mail</label>
      <input id="email" name="email" type="email" required autocomplete="username" ${activeIdps.length === 0 ? 'autofocus' : ''}>
      <label for="password">Passwort</label>
      <input id="password" name="password" type="password" required autocomplete="current-password">
      <button type="submit">Anmelden &amp; autorisieren</button>
    </form>`
    : '';

  const body = `
    <h1>Anmelden</h1>
    <div class="sub">${escapeHtml(opts.clientName ?? 'Ein MCP-Client')} möchte Zugriff${opts.scope ? ` · Scope: <code>${escapeHtml(opts.scope)}</code>` : ''}</div>
    ${ssoButtons}
    ${localForm}
    ${opts.error ? `<div class="error">${escapeHtml(opts.error)}</div>` : ''}
    <div class="meta">${escapeHtml(config.SERVER_NAME)} · OAuth 2.1 Authorization Server (Test)</div>`;
  res.set('Cache-Control', 'no-store').status(200).send(page('Anmelden', body));
}
