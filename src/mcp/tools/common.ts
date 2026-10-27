import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { config } from '../../config.js';
import { isProjoError, ProjoError, type ProjoErrorCode } from '../../projo/errors.js';
import { log } from '../../util/log.js';
import { respond, type ToolResponse } from '../respond.js';

/** Was die Tool-Handler vom SDK-`extra` brauchen (strukturell kompatibel zu RequestHandlerExtra). */
export interface ToolExtra {
  authInfo?: AuthInfo;
  signal?: AbortSignal;
}

export interface Caller {
  email: string;
  name?: string;
  idp?: string;
}

/** Identität aus dem Bearer-Token (JWT) – Schlüssel für die projo-Sitzung. */
export function callerOf(extra: ToolExtra): Caller {
  const e = extra.authInfo?.extra ?? {};
  const email = typeof e.email === 'string' ? e.email : undefined;
  if (!email) throw new ProjoError('invalid_input', 'Im Zugriffstoken fehlt die Identität (E-Mail).');
  return {
    email,
    ...(typeof e.name === 'string' ? { name: e.name } : {}),
    ...(typeof e.idp === 'string' ? { idp: e.idp } : {}),
  };
}

const CONNECT_CODES: ProjoErrorCode[] = ['projo_not_connected', 'projo_login_required', 'projo_login_failed'];

export const connectHint = (): string =>
  `Bitte die Person bitten, ${config.CONNECT_URL} im Browser zu öffnen und dort ihr projo-Konto zu verbinden (Zugangsdaten nie im Chat abfragen); danach projo_status aufrufen.`;

const NEXT_STEPS: Partial<Record<ProjoErrorCode, string>> = {
  projo_forbidden: 'Die Person hat in projo keine Berechtigung für diese Ansicht – nicht erneut versuchen.',
  projo_unavailable: 'projo ist gerade nicht erreichbar oder beschäftigt – in einigen Sekunden erneut versuchen.',
  drift_detected: 'Die projo-Oberfläche hat sich offenbar geändert; Ergebnis nicht raten. Die Person informieren, dass der Ablauf angepasst werden muss.',
  validation_failed: 'Eingaben anhand von error.details korrigieren und erneut aufrufen.',
  invalid_input: 'Parameter korrigieren und erneut aufrufen.',
};

/** Einheitliche Fehlerantwort: `{ error: { code, message, connectUrl? } }` + passende nextSteps, `isError: true`. */
export function toolError(err: unknown, tool: string): ToolResponse {
  if (isProjoError(err)) {
    const needsConnect = CONNECT_CODES.includes(err.code);
    if (err.code === 'drift_detected') log('warn', 'projo: Drift erkannt', { tool, message: err.message, details: err.details });
    const payload = {
      error: {
        code: err.code,
        message: err.message,
        ...(needsConnect ? { connectUrl: config.CONNECT_URL } : {}),
        ...(err.details ? { details: err.details } : {}),
      },
    };
    const next = needsConnect ? [connectHint()] : NEXT_STEPS[err.code] ? [NEXT_STEPS[err.code]!] : undefined;
    return { ...respond(payload, next), isError: true };
  }
  log('error', 'Tool-Fehler', { tool, error: err instanceof Error ? err.message : String(err) });
  return { ...respond({ error: { code: 'internal_error', message: 'Unerwarteter Fehler im projo-MCP-Server.' } }), isError: true };
}

/** Tool-Rumpf mit einheitlicher Fehlerbehandlung. */
export async function runTool(tool: string, extra: ToolExtra, fn: (caller: Caller) => Promise<ToolResponse>): Promise<ToolResponse> {
  try {
    return await fn(callerOf(extra));
  } catch (err) {
    return toolError(err, tool);
  }
}

/** Leere Arrays/Strings aus Antworten entfernen (spart Tokens). */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => !(v === undefined || v === '' || (Array.isArray(v) && v.length === 0))),
  ) as Partial<T>;
}
