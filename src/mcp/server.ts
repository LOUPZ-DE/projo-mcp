import type { Request, Response } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from '../config.js';
import { log } from '../util/log.js';
import { respond } from './respond.js';

/**
 * Ebene 1 der Selbsterklärung: `instructions` im InitializeResult.
 * Clients legen diesen Text in den System-Prompt — er steht also VOR dem
 * ersten Tool-Aufruf bereit. Knapp halten: Arbeitsablauf, Regeln, Grenzen.
 */
const INSTRUCTIONS = [
  'This server is an OAuth/DCR reference with four test tools.',
  'Suggested order: 1) whoami — verify authentication and identity passthrough (shows email, name, idp, notionUserId). 2) echo — verify argument passing. 3) slow_task — verify timeout behavior. 4) log_note — the only writing tool (writes to the server log, non-destructive).',
  'Rules: echo, slow_task and log_note require arguments; call whoami with arguments={}. slow_task caps at 60 seconds. Tool answers are JSON text blocks; when a "nextSteps" field is present, prefer those follow-ups.',
].join(' ');

function createMcpServer(): McpServer {
  // serverInfo.icons (MCP-Spec 2025-11-25, SEP-973): visuelle Identität des Servers
  // für Clients, die sie rendern (z. B. Verbindungs-Dialogs).
  const server = new McpServer(
    {
      name: config.SERVER_NAME,
      version: '1.0.0',
      websiteUrl: config.BASE_URL,
      icons: [{ src: `${config.BASE_URL}/icon.png`, mimeType: 'image/png', sizes: ['256x256'] }],
    },
    { instructions: INSTRUCTIONS },
  );

  // 1. whoami — verifiziert Identity-Passthrough: liest die Identität aus dem Bearer-Token.
  // Bewusst OHNE inputSchema registriert: Das SDK zod-validiert sonst auch `undefined`
  // (abgelehnt mit -32602), obwohl `arguments` in der MCP-Spec optional ist. Ohne Schema
  // akzeptiert der Server den Call mit weggelassenem arguments UND mit {}.
  server.registerTool(
    'whoami',
    {
      // Ebene 2: Beschreibung benennt den Folgeschritt.
      description: 'Returns the authenticated user of this MCP server (email, name, idp, notionUserId). Start here to verify auth, then try echo for argument passing.',
      // title + annotations (siehe README-Abschnitt "Tool annotations"): clients wie Notion
      // zeigen title statt des snake_case-Namens und steuern Auto-Run vs. Nachfragen.
      title: 'Who am I (identity check)',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (extra) => {
      const authInfo = extra.authInfo;
      if (!authInfo) {
        return respond({ status: 'unauthenticated', hint: 'no AuthInfo on request (should not happen — bearer middleware guards /mcp)' });
      }
      const identity = {
        email: authInfo.extra?.email,
        name: authInfo.extra?.name,
        idp: authInfo.extra?.idp,
        notionUserId: authInfo.extra?.notionUserId,
        clientId: authInfo.clientId,
        scopes: authInfo.scopes,
        expiresAt: authInfo.expiresAt ? new Date(authInfo.expiresAt * 1000).toISOString() : undefined,
      };
      // Ebene 3: nextSteps — konkret ausgefüllt, konditional (hier: immer sinnvoll)
      return respond(identity, [
        'echo with {"text": "<any string>"} to verify argument passing',
        `slow_task with {"seconds": 3} to verify timeout behavior (token expires ${identity.expiresAt ?? 'unknown'})`,
        'log_note with {"note": "..."} — the write-tier demo (readOnlyHint: false, destructiveHint: false)',
      ]);
    },
  );

  // 2. echo — verifiziert Argument-Übergabe
  server.registerTool(
    'echo',
    {
      description: 'Echoes the given text back. Verifies argument passing; for auth identity use whoami instead.',
      title: 'Echo text',
      inputSchema: { text: z.string().describe('The text to echo back') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ text }) =>
      respond(
        { echo: text, length: text.length },
        // nextSteps konditional: langer Input → Hinweis auf slow_task als nächstes Experiment
        text.length > 200
          ? ['slow_task with {"seconds": 5} to verify timeout behavior with longer-running calls']
          : ['whoami to verify which identity this call carries'],
      ),
  );

  // 3. slow_task — verifiziert Timeout-Verhalten (honoriert Abort via extra.signal)
  server.registerTool(
    'slow_task',
    {
      description: 'Waits n seconds, then answers. Verifies client timeout behavior. Cap: 60s.',
      title: 'Slow task (timeout test)',
      inputSchema: {
        seconds: z.number().min(0).max(60).default(5).describe('Wait time in seconds (max. 60)'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ seconds }, extra) => {
      const deadline = Date.now() + seconds * 1000;
      while (Date.now() < deadline) {
        if (extra.signal.aborted) {
          return respond({ aborted: true, waitedSeconds: Math.round((seconds * 1000 - (deadline - Date.now())) / 1000) });
        }
        await new Promise((r) => setTimeout(r, Math.min(250, deadline - Date.now())));
      }
      return respond(
        { waitedSeconds: seconds },
        // Konditional: nahe am Cap → Hinweis auf die 60s-Grenze als Folgeexperiment
        seconds >= 30
          ? ['values above 60 are rejected by the schema — that cap is the demonstration']
          : [`slow_task with {"seconds": ${Math.min(60, seconds * 4)}} to approach the client timeout`],
      );
    },
  );

  // 4. log_note — SCHREIBT (ins Server-Log), aber nicht destruktiv:
  // die "mittlere Stufe" der Tool-Annotations (readOnlyHint: false + destructiveHint: false).
  // Ein Client kann das anders behandeln als echte destruktive Writes — ohne die explizite
  // Angabe würde der Default (destructiveHint: true bei readOnlyHint: false) greifen.
  server.registerTool(
    'log_note',
    {
      description: 'Writes a note to the server log. The write-tier demo: it writes, but changes nothing destructively (like a draft, not a send).',
      title: 'Write note to server log',
      inputSchema: { note: z.string().min(1).max(500).describe('The note to write to the server log') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ note }, extra) => {
      const email = extra.authInfo?.extra?.email ?? 'unknown';
      log('info', 'log_note', { note, email });
      return respond({ logged: true, note, by: email }, [
        'whoami to see which identity wrote this note',
      ]);
    },
  );

  return server;
}

/**
 * Stateless Streamable HTTP: pro Request frischer Server + Transport.
 * Kein Session-Store nötig — passt zum Container-Betrieb (horizontal skalierbar, sticky-frei).
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
