/**
 * Antwort-Konvention für selbsterklärende MCP-Server.
 *
 * Drei Ebenen (hier implementiert bzw. in mcp/server.ts zu sehen):
 *   1. `instructions` im InitializeResult  — Arbeitsablauf & Regeln, landet im
 *      System-Prompt des Clients, BEVOR der erste Tool-Call passiert.
 *   2. Tool-Beschreibungen mit Folgeschritt — was danach sinnvoll ist.
 *   3. `nextSteps` in jeder Antwort — diese Funktion. Konkret (mit ausgefüllten
 *      Werten) und KONDITIONAL: nur Hinweise, die im aktuellen Kontext zutreffen.
 *      Tokens für unzutreffende Hinweise sind schlechter als keine Hinweise.
 */
export interface ToolResponse {
  content: { type: 'text'; text: string }[];
  [key: string]: unknown;
}

export function respond(payload: Record<string, unknown>, nextSteps?: string[]): ToolResponse {
  const body = nextSteps && nextSteps.length > 0 ? { ...payload, nextSteps } : payload;
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }] };
}
