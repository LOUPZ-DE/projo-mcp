import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../../config.js';
import { isProjoError } from '../../projo/errors.js';
import { projoSessions } from '../../projo/runtime.js';
import { todayBerlin } from '../../projo/util/de.js';
import { respond } from '../respond.js';
import { compact, connectHint, runTool } from './common.js';

export function registerStatusTool(server: McpServer): void {
  // Bewusst OHNE inputSchema (Notion schickt teils gar kein `arguments`; mit Schema lehnt das SDK ab).
  server.registerTool(
    'projo_status',
    {
      title: 'projo: Verbindungsstatus',
      description:
        'Zeigt, wer angemeldet ist und ob ein projo-Konto verbunden ist (prüft die Sitzung live). Immer zuerst aufrufen. ' +
        'Ist nichts verbunden oder die Sitzung abgelaufen, enthält die Antwort einen connectUrl-Link, den die Person im Browser öffnet.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (extra) =>
      runTool('projo_status', extra, async (caller) => {
        let status = projoSessions.status(caller.email);
        let live: Record<string, unknown> | undefined;
        if (status.method) {
          try {
            const profile = await projoSessions.validate(caller.email);
            live = { ok: true, ...profile };
          } catch (err) {
            live = { ok: false, code: isProjoError(err) ? err.code : 'error', message: err instanceof Error ? err.message : String(err) };
          }
          status = projoSessions.status(caller.email);
        }
        const needsConnect = !status.connected;
        return respond(
          compact({
            user: caller,
            projo: { ...status, ...(live ? { live } : {}) },
            connectUrl: config.CONNECT_URL,
          }),
          needsConnect
            ? [connectHint()]
            : [
                `projo_time_entries with {"from": "${todayBerlin()}"} – Buchungen von heute`,
                'projo_time_options with {"query": "<Stichwort>"} – Leistung zum Buchen finden',
                'projo_read_page with {"path": "/app/absences"} – Urlaubskonto und Abwesenheiten',
              ],
        );
      }),
  );
}
