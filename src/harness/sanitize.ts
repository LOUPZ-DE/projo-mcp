import * as cheerio from 'cheerio';

/**
 * Seiten-HTML für ein LLM eindampfen – Datensparsamkeit zuerst:
 * Skripte, Styles, Navigation, versteckte Felder (CSRF-Token) und Passwortfelder fliegen raus, Attribute bis auf
 * eine kleine Whitelist werden entfernt, E-Mail-Adressen maskiert. Cookies stehen ohnehin nie im HTML.
 */
const KEEP_ATTRS = new Set(['id', 'title', 'href', 'data-href', 'colspan', 'rowspan', 'data-bip-value', 'data-bip-attribute', 'data-row-id', 'name', 'value']);

export function condenseHtml(html: string, maxChars = 60_000): string {
  const $ = cheerio.load(html);
  $('head, script, style, noscript, svg, link, meta, template, iframe, img, nav, .navbar, footer, .dropdown-menu').remove();
  $('input[type="hidden"], input[type="password"], input[name="authenticity_token"]').remove();
  $('select option:not([selected])').remove();
  for (const el of $('*').toArray()) {
    if (el.type !== 'tag') continue;
    for (const name of Object.keys(el.attribs)) if (!KEEP_ATTRS.has(name)) delete el.attribs[name];
  }
  const out = ($('body').html() ?? $.root().html() ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
    .replace(/https?:\/\/[^\s"'<>]+?(\/[^\s"'<>]*)/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><');
  return out.length > maxChars ? `${out.slice(0, maxChars)} …[gekürzt]` : out;
}
