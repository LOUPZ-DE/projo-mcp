import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from '../../config.js';
import { ProjoError } from '../../projo/errors.js';
import { summarizePage } from '../../projo/pages/generic.js';
import { projoSessions } from '../../projo/runtime.js';
import { respond } from '../respond.js';
import { compact, runTool } from './common.js';

/**
 * Pfade, die der generische Leser nie abruft – auch wenn projo dort per GET antworten würde:
 * Login/Logout/SSO, projo-Admin, Websocket, Nutzereinstellungen und alles, was nach Aktion aussieht.
 */
const DENY: RegExp[] = [
  /^\/logout/i,
  /^\/login/i,
  /^\/auth\//i,
  /^\/admin/i,
  /^\/cable/i,
  /^\/password_resets/i,
  /^\/rails\//i,
  /^\/user\//i,
  /sign_out/i,
  /\/(destroy|delete)(\/|\?|$)/i,
  /(filter_treaty|leaf_chosen|change_online_status|update_task|update_order|change_to_absence|choose_break)/i,
];

export function checkReadPath(input: string): string {
  let path = input.trim();
  if (/^https?:\/\//i.test(path)) {
    const url = new URL(path);
    if (url.origin !== new URL(config.PROJO_BASE_URL).origin) throw new ProjoError('blocked', `Nur Seiten von ${config.PROJO_BASE_URL} können gelesen werden.`);
    path = url.pathname + url.search;
  }
  if (!path.startsWith('/') || path.startsWith('//')) throw new ProjoError('invalid_input', 'Der Pfad muss mit / beginnen, z. B. /app/dates/today.');
  if (DENY.some((r) => r.test(path))) throw new ProjoError('blocked', `Der Pfad ${path} ist für den Leser gesperrt.`);
  return path;
}

export function registerReadPageTool(server: McpServer): void {
  server.registerTool(
    'projo_read_page',
    {
      title: 'projo: Seite lesen',
      description:
        'Liest eine beliebige projo-Seite NUR LESEND (HTTP-GET mit der Sitzung der Person) und liefert Titel, Tabellen als ' +
        'Zeilen-Objekte, Formular-Feldnamen, interne Links und Resttext. Für Ansichten ohne eigenes Tool, z. B. ' +
        '/app/dates/<YYYY-MM-DD>, /app/weeks/index?date=<YYYY-MM-DD>, /app/months?date=<YYYY-MM-DD>, /app/absences, ' +
        '/app/bookings_analysis?date=<TT.MM.JJJJ>&end_date=<TT.MM.JJJJ>. Links mit "method" (patch/delete/post) sind Aktionen – nie selbst auslösen.',
      inputSchema: {
        path: z.string().min(1).max(500).describe('Pfad innerhalb von projo, z. B. /app/dates/today'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ path }, extra) =>
      runTool('projo_read_page', extra, async (caller) => {
        const target = checkReadPath(path);
        const page = await projoSessions.withUser(caller.email, ({ http }) => http.getPage(target));
        if (!/html|javascript/i.test(page.contentType)) {
          return respond({ path: target, contentType: page.contentType, note: 'Keine HTML-Seite (z. B. Datei-Download) – wird nicht ausgelesen.' });
        }
        const s = summarizePage(page.html, { baseUrl: config.PROJO_BASE_URL, detail: 'compact' });
        const tables = s.tables.map((t) => compact({ ...t, meta: t.meta.some((m) => m.id || m.links) ? t.meta : [] }));
        const forms = s.forms.map((f) =>
          compact({ action: f.action, method: f.httpMethod, fields: f.fields.filter((x) => x.name !== 'authenticity_token').map((x) => x.label ? `${x.name} (${x.label})` : x.name) }),
        );
        return respond(
          compact({
            path: target,
            ...(page.finalPath !== target ? { finalPath: page.finalPath } : {}),
            title: s.title,
            headings: s.headings,
            breadcrumb: s.breadcrumb,
            flash: s.flash,
            text: s.text,
            tables,
            forms,
            links: s.links,
          }),
          s.links.length > 0 ? ['projo_read_page with {"path": "<path eines Links ohne method>"} – verlinkte Seite lesen'] : undefined,
        );
      }),
  );
}
