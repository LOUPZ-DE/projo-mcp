import type { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../config.js';
import { log } from '../util/log.js';
import { registerProjoTools } from './tools/index.js';

/**
 * Ebene 1 der Selbsterklärung: `instructions` im InitializeResult.
 * Clients legen diesen Text in den System-Prompt — er steht also VOR dem
 * ersten Tool-Aufruf bereit. Knapp halten: Arbeitsablauf, Regeln, Grenzen.
 */
const INSTRUCTIONS = [
  'Dieser Server bedient die Controlling-Software projo (my.projo.berlin) mit dem eigenen projo-Konto der angemeldeten Person.',
  'Ablauf: 1) projo_status aufrufen (arguments={}). 2) Ist kein projo-Konto verbunden oder die Sitzung abgelaufen, der Person den connectUrl-Link nennen – sie verbindet ihr Konto dort im Browser; niemals Passwörter oder Codes im Chat erfragen. 3) Danach die fachlichen Tools nutzen; für Ansichten ohne eigenes Tool projo_read_page mit einem projo-Pfad.',
  'Zeiten: lesen mit projo_time_entries (Tag/Zeitraum) bzw. projo_time_summary (Stunden pro Projekt); buchen: projo_time_options (query oder contract) → taskId → projo_time_entry_create; ändern/löschen braucht die bookingId aus projo_time_entries (Zeitraum bis 10 Tage). Vor dem Buchen Datum, Dauer und Leistung mit der Person abstimmen, wenn sie nicht eindeutig sind.',
  'Regeln: Daten im ISO-Format (YYYY-MM-DD), Stunden dezimal. Links mit "method" (patch/delete/post) sind Aktionen und werden nie über projo_read_page ausgelöst. Antworten sind JSON; ein "nextSteps"-Feld nennt sinnvolle Folgeaufrufe, ein "error"-Feld enthält code, message und ggf. connectUrl.',
].join(' ');

function createMcpServer(): McpServer {
  // serverInfo.icons (MCP-Spec 2025-11-25, SEP-973): visuelle Identität des Servers
  // für Clients, die sie rendern (z. B. Verbindungs-Dialogs).
  const server = new McpServer(
    {
      name: config.SERVER_NAME,
      version: '0.1.0',
      websiteUrl: config.BASE_URL,
      icons: [
        { src: `${config.BASE_URL}/icon.png`, mimeType: 'image/png', sizes: ['256x256'] },
        { src: `${config.BASE_URL}/icon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
      ],
    },
    { instructions: INSTRUCTIONS },
  );
  registerProjoTools(server);
  return server;
}

/**
 * Stateless Streamable HTTP: pro Request frischer Server + Transport.
 * Kein Session-Store nötig — passt zum Container-Betrieb (horizontal skalierbar, sticky-frei).
 * (Die projo-Sitzungen leben unabhängig davon als Modul-Singletons in src/projo/runtime.ts.)
 */
export async function mcpPostHandler(req: Request, res: Response): Promise<void> {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    // req.auth (von requireBearerAuth gesetzt) reicht der Transport als authInfo an die Tool-Handler durch.
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log('error', 'Fehler im MCP-Transport', { error: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
}

/** Stateless = kein Standalone-SSE-Stream und kein Session-Terminate → spec-konform 405. */
export function mcpMethodNotAllowedHandler(_req: Request, res: Response): void {
  res
    .set('Allow', 'POST')
    .status(405)
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: nur POST /mcp).' }, id: null });
}
