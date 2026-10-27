import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerReadPageTool } from './readPage.js';
import { registerStatusTool } from './status.js';
import { registerTimeTools } from './time.js';

/** Alle projo-Tools am (pro Request neu erzeugten) McpServer registrieren. */
export function registerProjoTools(server: McpServer): void {
  registerStatusTool(server);
  registerReadPageTool(server);
  registerTimeTools(server);
}
