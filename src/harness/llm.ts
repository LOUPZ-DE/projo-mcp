import OpenAI from 'openai';
import { config } from '../config.js';
import { ProjoError } from '../projo/errors.js';

/**
 * Schlanker LLM-Client für den optionalen Harness (Ausweich-Extraktion, Reparaturvorschläge).
 * OpenAI-kompatibel – Standard ist der LLM-Router Requesty (EU-Endpunkt). Ohne REQUESTY_API_KEY ist der
 * Harness komplett aus. Schreibvorgänge in projo laufen NIE über das LLM.
 */

export interface JsonRequest {
  system: string;
  user: string;
  /** Name des JSON-Schemas (a–z, 0–9, _ und -) */
  schemaName: string;
  /** JSON-Schema im „strict“-Stil: alle Felder required, additionalProperties: false, optionale Werte als null */
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export interface LlmClient {
  readonly model: string;
  json<T = unknown>(req: JsonRequest): Promise<T>;
}

/** Manche Modelle verpacken JSON trotz response_format in ```json-Zäune. */
function stripFences(text: string): string {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return m ? m[1]! : text;
}

export function createLlmClient(opts: { apiKey: string; baseURL: string; model: string; timeoutMs?: number }): LlmClient {
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL, timeout: opts.timeoutMs ?? 45_000, maxRetries: 1 });
  return {
    model: opts.model,
    async json<T>(req: JsonRequest): Promise<T> {
      const res = await client.chat.completions.create({
        model: opts.model,
        temperature: 0,
        max_tokens: req.maxTokens ?? 4000,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        response_format: { type: 'json_schema', json_schema: { name: req.schemaName, strict: true, schema: req.schema } },
      });
      const text = res.choices[0]?.message?.content ?? '';
      try {
        return JSON.parse(stripFences(text)) as T;
      } catch {
        throw new ProjoError('drift_detected', 'Die KI-Ausweich-Extraktion hat kein gültiges JSON geliefert.');
      }
    },
  };
}

/** Prozessweiter Client – undefined, wenn kein Requesty-Key konfiguriert ist. */
export const llm: LlmClient | undefined =
  config.REQUESTY_API_KEY && config.REQUESTY_MODEL
    ? createLlmClient({ apiKey: config.REQUESTY_API_KEY, baseURL: config.REQUESTY_BASE_URL, model: config.REQUESTY_MODEL })
    : undefined;
