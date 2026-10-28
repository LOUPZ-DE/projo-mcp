import { writeFileSync } from 'node:fs';
import { isProjoError, ProjoError } from '../projo/errors.js';
import { log } from '../util/log.js';
import { recordDrift } from './drift.js';
import { llm as defaultLlm, type LlmClient } from './llm.js';
import { condenseHtml } from './sanitize.js';

/**
 * KI-Reserve für LESENDE Abläufe: Scheitert ein fester Parser an einer geänderten projo-Seite (drift_detected),
 * extrahiert das LLM dieselben Daten nach festem JSON-Schema. Das Ergebnis wird als `degraded` markiert, die
 * Seite als Drift-Schnappschuss abgelegt und – im Hintergrund – ein Reparaturvorschlag erzeugt.
 * Schreibvorgänge nutzen das nie.
 */

export interface ExtractSpec<T> {
  /** Kurzname, z. B. time_day */
  key: string;
  /** Was extrahiert werden soll (deutsch, präzise) */
  task: string;
  /** JSON-Schema im strict-Stil */
  schema: Record<string, unknown>;
  /** Rohwert prüfen und in das Zielformat überführen (wirft bei Unsinn) */
  map: (raw: unknown) => T;
  /** Was der feste Parser erwartet (für Reparaturvorschläge) */
  expectation?: string;
}

const SYSTEM = [
  'Du extrahierst strukturierte Daten aus einer Seite der Controlling-Software projo (deutschsprachig).',
  'Antworte ausschließlich mit JSON gemäß Schema. Erfinde nichts – fehlende Werte als null, fehlende Listen leer.',
  'Zeitdauern wie "02:30 h" oder "1,5 h" als Dezimalzahl in Stunden (2.5 bzw. 1.5), negative Werte mit Minus.',
  'Daten als YYYY-MM-DD. IDs exakt so übernehmen, wie sie im HTML stehen (z. B. id="booking-123" → "123").',
].join(' ');

export async function extractWithLlm<T>(client: LlmClient, html: string, spec: ExtractSpec<T>): Promise<T> {
  const raw = await client.json({
    system: SYSTEM,
    user: `${spec.task}\n\nHTML (bereinigt):\n${condenseHtml(html)}`,
    schemaName: spec.key,
    schema: spec.schema,
  });
  return spec.map(raw);
}

export interface FallbackResult<T> {
  value: T;
  degraded: boolean;
}

export async function parseWithFallback<T>(html: string, parse: () => T, spec: ExtractSpec<T>, client: LlmClient | undefined = defaultLlm): Promise<FallbackResult<T>> {
  try {
    return { value: parse(), degraded: false };
  } catch (err) {
    if (!(isProjoError(err) && err.code === 'drift_detected')) throw err;
    const snapshot = recordDrift(spec.key, html, err.message);
    log('warn', 'projo: Drift erkannt', { key: spec.key, reason: err.message, snapshot, llmFallback: Boolean(client) });
    if (!client) throw err;
    try {
      const value = await extractWithLlm(client, html, spec);
      log('warn', 'projo: KI-Ausweich-Extraktion genutzt', { key: spec.key, model: client.model });
      if (snapshot) void suggestRepair(client, html, spec, err.message, snapshot);
      return { value, degraded: true };
    } catch (fallbackErr) {
      log('error', 'projo: KI-Ausweich-Extraktion fehlgeschlagen', { key: spec.key, error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr) });
      throw err;
    }
  }
}

const REPAIR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'selectors'],
  properties: {
    summary: { type: 'string' },
    selectors: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['purpose', 'selector'], properties: { purpose: { type: 'string' }, selector: { type: 'string' } } },
    },
  },
};

/** Reparaturvorschlag (nur Datei/Log, wird nie automatisch angewendet). */
async function suggestRepair<T>(client: LlmClient, html: string, spec: ExtractSpec<T>, reason: string, snapshot: string): Promise<void> {
  try {
    const suggestion = await client.json({
      system: 'Du hilfst, einen HTML-Parser (cheerio, CSS-Selektoren) an eine geänderte Webseite anzupassen. Antworte knapp auf Deutsch als JSON.',
      user: `Der Parser „${spec.key}“ ist gescheitert: ${reason}\nErwartet war: ${spec.expectation ?? spec.task}\nSchlage robuste CSS-Selektoren für die neue Struktur vor.\n\nHTML (bereinigt):\n${condenseHtml(html, 40_000)}`,
      schemaName: 'repair_suggestion',
      schema: REPAIR_SCHEMA,
      maxTokens: 1500,
    });
    writeFileSync(`${snapshot}.suggestion.json`, JSON.stringify(suggestion, null, 2), { encoding: 'utf8', mode: 0o600 });
    log('info', 'projo: Reparaturvorschlag abgelegt', { key: spec.key, file: `${snapshot}.suggestion.json` });
  } catch (err) {
    log('warn', 'projo: Reparaturvorschlag fehlgeschlagen', { key: spec.key, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Hilfen für map(): Rohwerte defensiv prüfen. */
export function asObject(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ProjoError('drift_detected', `KI-Antwort ohne ${what}.`);
  return v as Record<string, unknown>;
}
export const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const asNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
export const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
