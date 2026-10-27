import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';

/** Whitespace normalisieren (inkl. &nbsp;) – Projo rendert stark eingerücktes HTML. */
export function cleanText(s: string | undefined | null): string {
  return (s ?? '').replace(/[\s ]+/g, ' ').trim();
}

export function textOf($: CheerioAPI, el: AnyNode | Cheerio<AnyNode>): string {
  return cleanText($(el).text());
}

/** Elemente, deren Inhalt vom Nachbartext getrennt wird (cheerio.text() klebt sonst „1 Tag“+„von 5 Tage“ zusammen). */
const SEPARATED = new Set([
  'br', 'div', 'p', 'li', 'ul', 'ol', 'tr', 'td', 'th', 'table', 'small', 'span', 'label', 'button', 'a',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'header', 'footer', 'font', 'b', 'strong', 'i', 'em',
]);
const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'svg']);

/** Lesbarer Text eines Knotens: Elementgrenzen werden zu Leerzeichen, Skripte entfallen. */
export function readableText(node: AnyNode | undefined): string {
  if (!node) return '';
  const parts: string[] = [];
  const walk = (n: AnyNode): void => {
    if (n.type === 'text') {
      parts.push((n as unknown as { data: string }).data);
      return;
    }
    if (!('children' in n)) return;
    const name = 'name' in n ? String((n as { name: string }).name).toLowerCase() : '';
    if (SKIPPED.has(name)) return;
    const sep = SEPARATED.has(name);
    if (sep) parts.push(' ');
    for (const c of (n as { children: AnyNode[] }).children) walk(c);
    if (sep) parts.push(' ');
  };
  walk(node);
  return cleanText(parts.join(''));
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
