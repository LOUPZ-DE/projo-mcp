import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { log } from '../util/log.js';

export interface AuditEntry {
  /** MCP-Identität (E-Mail) */
  user: string;
  /** z. B. time_entry.create, connect.password, disconnect */
  action: string;
  result: 'ok' | 'error';
  /** fachliche Eckdaten ohne Geheimnisse (Datum, Dauer, IDs …) */
  details?: Record<string, unknown>;
  error?: string;
}

/** Append-only JSON-Lines-Protokoll aller schreibenden Aktionen (Datei 0600). */
export class AuditLog {
  constructor(private readonly file: string) {}

  write(entry: AuditEntry): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      appendFileSync(this.file, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      log('error', 'Audit-Log nicht schreibbar', { file: this.file, error: err instanceof Error ? err.message : String(err) });
    }
    log('info', `audit: ${entry.action}`, { user: entry.user, result: entry.result, ...(entry.error ? { error: entry.error } : {}) });
  }
}
