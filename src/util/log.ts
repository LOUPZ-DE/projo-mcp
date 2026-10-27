import type { NextFunction, Request, Response } from 'express';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Einzeiliger JSON-Logger — containerfreundlich (stdout). */
export function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

const REDACT_KEYS = new Set(['password', 'code_verifier', 'client_secret', 'refresh_token', 'access_token', 'code']);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, REDACT_KEYS.has(k) ? '<redacted>' : redact(v)]),
    );
  }
  return value;
}

/** Pfade, auf denen auch der (redigierte) Request-Body geloggt wird — PRD: "sehen, was Notion tatsächlich sendet". */
const BODY_LOG_PATHS = new Set(['/register', '/token', '/authorize']);

/**
 * Request-Logging für alle Endpunkte. Auf den Auth-Endpunkten wird zusätzlich
 * der geparste Body geloggt (mit redigierten Secrets) — dafür muss diese
 * Middleware NACH den Body-Parsern laufen, bzw. wir loggen erst am Response-Ende.
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const entry: Record<string, unknown> = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
      contentType: req.get('content-type'),
      origin: req.get('origin'),
      userAgent: req.get('user-agent'),
    };
    if (Object.keys(req.query).length > 0) entry.query = redact(req.query);
    if (BODY_LOG_PATHS.has(req.path) && req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
      entry.body = redact(req.body);
    }
    log('info', `${req.method} ${req.path} → ${res.statusCode}`, entry);
  });
  next();
}
