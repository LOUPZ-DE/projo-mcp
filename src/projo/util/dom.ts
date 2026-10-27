import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';

/** Whitespace normalisieren (inkl. &nbsp;) – Projo rendert stark eingerücktes HTML. */
export function cleanText(s: string | undefined | null): string {
  return (s ?? '').replace(/[\s ]+/g, ' ').trim();
}

export function textOf($: CheerioAPI, el: AnyNode | Cheerio<AnyNode>): string {
  return cleanText($(el).text());
}

/**
 * Nur Links auf denselben Host durchlassen und auf Pfad + Query kürzen.
 * Anker, javascript:, mailto: usw. → undefined.
 */
export function toInternalPath(href: string | undefined, baseUrl: string): string | undefined {
  if (!href) return undefined;
  const h = href.trim();
  if (!h || h.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(h)) return undefined;
  try {
    const base = new URL(baseUrl);
    const url = new URL(h, base);
    if (url.origin !== base.origin) return undefined;
    return url.pathname + url.search;
  } catch {
    return undefined;
  }
}

/**
 * rails-ujs-Antworten (`data-remote`, Format js) sind server-generiertes JavaScript, das HTML per
 * `$(...).html("…")` einsetzt. Diese Funktion holt alle längeren String-Literale mit Markup heraus und
 * entschlüsselt Rails' `escape_javascript` (\n, \", \', \/, \$, \`, \uXXXX).
 */
export function extractHtmlFromJs(js: string): string {
  const out: string[] = [];
  const literal = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
  for (const m of js.matchAll(literal)) {
    const raw = m[1] ?? m[2] ?? '';
    if (raw.length < 20 || !raw.includes('<')) continue;
    try {
      // escape_javascript maskiert beide Anführungszeichen → nach Entfernen der JS-only-Escapes ist es gültiges JSON
      const jsonSafe = raw.replace(/\\'/g, "'").replace(/\\\$/g, '$').replace(/\\`/g, '`');
      out.push(JSON.parse(`"${jsonSafe}"`) as string);
    } catch {
      out.push(raw.replace(/\\n/g, '\n').replace(/\\(["'/$`])/g, '$1'));
    }
  }
  return out.join('\n');
}

/** Feldnamen, deren Werte nie ausgegeben werden (CSRF-Token, Passwörter, Secrets). */
const SENSITIVE_NAME = /(authenticity_token|password|passwort|token|secret|otc|otp)/i;

export function isSensitiveName(name: string | undefined): boolean {
  return !!name && SENSITIVE_NAME.test(name);
}
