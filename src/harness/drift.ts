import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { log } from '../util/log.js';
import { condenseHtml } from './sanitize.js';

/**
 * Drift-Protokoll: Hat sich die projo-Oberfläche geändert, wird ein bereinigter Schnappschuss der Seite abgelegt
 * (DATA_DIR/drift, Dateirechte 0600, Aufbewahrung 7 Tage) – Grundlage, um den Parser bzw. das Rezept anzupassen.
 */
const RETENTION_MS = 7 * 24 * 3_600_000;

export function driftDir(): string {
  return join(config.DATA_DIR, 'drift');
}

export function recordDrift(key: string, html: string, reason: string): string | undefined {
  try {
    const dir = driftDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    pruneDrift(dir);
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${key.replace(/[^a-z0-9_-]/gi, '_')}.html`);
    writeFileSync(file, `<!-- ${reason.replace(/--/g, '—')} -->\n${condenseHtml(html, 200_000)}`, { encoding: 'utf8', mode: 0o600 });
    return file;
  } catch (err) {
    log('warn', 'Drift-Schnappschuss nicht geschrieben', { key, error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

function pruneDrift(dir: string): void {
  const cutoff = Date.now() - RETENTION_MS;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (statSync(p).mtimeMs < cutoff) rmSync(p);
    } catch {
      // egal – nächster Lauf räumt auf
    }
  }
}
