import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { cleanText, isSensitiveName, readableText, toInternalPath } from '../util/dom.js';

/**
 * Generischer Seiten-Leser: macht aus einer server-gerenderten Projo-Seite eine strukturierte,
 * LLM-taugliche Zusammenfassung (Tabellen als Zeilen-Objekte, Formulare, Links, Resttext).
 *
 * Genutzt von `projo_read_page` (detail: 'compact') und vom Discovery-Skript (detail: 'full').
 * Reine Funktion ohne Netzwerk/Config – testbar gegen Fixtures.
 */

export interface SummarizeOptions {
  baseUrl: string;
  /** compact = für das LLM (keine Feldwerte/Optionen/data-Attribute); full = für Discovery/Entwicklung */
  detail?: 'compact' | 'full';
  maxTables?: number;
  maxRowsPerTable?: number;
  maxLinks?: number;
  maxText?: number;
}

export interface TableRowMeta {
  id?: string;
  section: 'body' | 'foot';
  links?: string[];
}

export interface TableSummary {
  index: number;
  id?: string;
  caption?: string;
  headers: string[];
  rows: Record<string, string>[];
  meta: TableRowMeta[];
  rowCount: number;
  truncated: boolean;
}

export interface FormFieldSummary {
  name: string;
  tag: string;
  type?: string;
  id?: string;
  label?: string;
  value?: string;
  required?: boolean;
  disabled?: boolean;
  multiple?: boolean;
  options?: { value: string; label: string; selected?: boolean }[];
  optionCount?: number;
  data?: Record<string, string>;
}

export interface FormSummary {
  index: number;
  id?: string;
  action?: string;
  method: string;
  /** Effektive HTTP-Methode inkl. Rails-Override `_method` (patch/put/delete) */
  httpMethod: string;
  turbo?: string;
  fields: FormFieldSummary[];
  submitters: { name?: string; value?: string; text: string }[];
  data?: Record<string, string>;
}

export interface LinkSummary {
  text: string;
  path: string;
  /** Nicht-GET-Links (rails-ujs `data-method`, Turbo `data-turbo-method`) – nie automatisch folgen */
  method?: string;
}

export interface PageSummary {
  title: string;
  headings: string[];
  breadcrumb: string[];
  flash: string[];
  tables: TableSummary[];
  forms: FormSummary[];
  links: LinkSummary[];
  frames: { id: string; src?: string }[];
  /** data-*-url/-href/-route-Attribute (nachladbare Fragmente, select2-AJAX-Quellen …) – nur detail: 'full' */
  lazyUrls: string[];
  /** Stimulus-Controller auf der Seite – nur detail: 'full' */
  controllers: string[];
  /** Seitentext ohne Navigation, Tabellen und Skripte (gekürzt) */
  text: string;
}

const DEFAULTS = {
  compact: { maxTables: 10, maxRowsPerTable: 60, maxLinks: 60, maxText: 4000 },
  full: { maxTables: 50, maxRowsPerTable: 10, maxLinks: 400, maxText: 8000 },
} as const;

export function summarizePage(html: string, opts: SummarizeOptions): PageSummary {
  const detail = opts.detail ?? 'compact';
  const limits = { ...DEFAULTS[detail], ...stripUndefined(opts) };
  const $ = cheerio.load(html);
  const full = detail === 'full';

  const tables = $('table')
    .toArray()
    .slice(0, limits.maxTables)
    .map((t, i) => parseTable($, $(t), i, limits.maxRowsPerTable, opts.baseUrl));

  const forms = $('form')
    .toArray()
    .map((f, i) => parseForm($, $(f), i, opts.baseUrl, full));

  const links = collectLinks($, opts.baseUrl, limits.maxLinks);

  const frames = $('turbo-frame[id]')
    .toArray()
    .map((f) => ({ id: $(f).attr('id')!, src: toInternalPath($(f).attr('src'), opts.baseUrl) }));

  return {
    title: cleanText($('title').first().text()),
    headings: uniq($('h1, h2, h3').toArray().map((h) => readableText(h))).slice(0, 20),
    breadcrumb: uniq($('.breadcrumb li, nav[aria-label="breadcrumb"] li').toArray().map((li) => readableText(li))),
    flash: uniq($('#flash_container_for_bip, .alert, [role="alert"], .flash').toArray().map((el) => readableText(el))),
    tables,
    forms,
    links,
    frames,
    lazyUrls: full ? collectDataUrls($, opts.baseUrl) : [],
    controllers: full ? uniq($('[data-controller]').toArray().flatMap((el) => ($(el).attr('data-controller') ?? '').split(/\s+/))) : [],
    text: extractText($, limits.maxText),
  };
}

// ─── Tabellen ────────────────────────────────────────────────────────────────

interface Cell {
  text: string;
}

/** colspan auflösen, damit Zellen und Überschriften über den Index zusammenpassen. */
/** Zelltext; reine Eingabezellen (z. B. Wochenraster) liefern ihre Feldwerte. */
function cellText($: CheerioAPI, c: Element): string {
  const text = readableText(c);
  if (text) return text;
  const values = $(c)
    .find('input[value]:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select option[selected]')
    .toArray()
    .map((e) => cleanText(e.tagName === 'textarea' || e.tagName === 'option' ? $(e).text() : $(e).attr('value')))
    .filter(Boolean);
  return values.join(' | ');
}

function expandCells($: CheerioAPI, cells: Element[]): Cell[] {
  const out: Cell[] = [];
  for (const c of cells) {
    const span = Math.min(Math.max(parseInt($(c).attr('colspan') ?? '1', 10) || 1, 1), 50);
    const text = cellText($, c);
    out.push({ text });
    for (let i = 1; i < span; i++) out.push({ text: '' });
  }
  return out;
}

function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = h || `Spalte ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

function parseTable($: CheerioAPI, table: Cheerio<Element>, index: number, maxRows: number, baseUrl: string): TableSummary {
  const rowsOf = (section: string) => table.children(section).children('tr').toArray();
  let headRows = rowsOf('thead');
  let bodyRows = [...rowsOf('tbody'), ...table.children('tr').toArray()];
  const footRows = rowsOf('tfoot');

  // Tabellen ohne <thead>: erste Zeile mit ausschließlich <th> ist der Kopf
  if (headRows.length === 0 && bodyRows.length > 0) {
    const first = $(bodyRows[0]);
    if (first.children('th').length > 0 && first.children('td').length === 0) {
      headRows = [bodyRows[0]];
      bodyRows = bodyRows.slice(1);
    }
  }

  const headerRow = headRows.length > 0 ? headRows[headRows.length - 1] : undefined;
  const headers = uniqueHeaders(headerRow ? expandCells($, $(headerRow).children('th, td').toArray()).map((c) => c.text) : []);

  const all = [
    ...bodyRows.map((r) => ({ r, section: 'body' as const })),
    ...footRows.map((r) => ({ r, section: 'foot' as const })),
  ];
  const rows: Record<string, string>[] = [];
  const meta: TableRowMeta[] = [];
  let rowCount = 0;
  for (const { r, section } of all) {
    const cells = expandCells($, $(r).children('th, td').toArray());
    if (cells.every((c) => !c.text)) continue;
    rowCount++;
    if (rows.length >= maxRows) continue;
    const row: Record<string, string> = {};
    cells.forEach((c, i) => {
      if (c.text) row[headers[i] ?? `Spalte ${i + 1}`] = c.text;
    });
    rows.push(row);
    const id = $(r).attr('id') ?? $(r).attr('data-id');
    const links = uniq(
      $(r)
        .find('a[href]')
        .toArray()
        .map((a) => toInternalPath($(a).attr('href'), baseUrl))
        .filter((p): p is string => !!p),
    ).slice(0, 3);
    meta.push({ ...(id ? { id } : {}), section, ...(links.length > 0 ? { links } : {}) });
  }

  const caption = cleanText(table.children('caption').first().text());
  return {
    index,
    ...(table.attr('id') ? { id: table.attr('id') } : {}),
    ...(caption ? { caption } : {}),
    headers,
    rows,
    meta,
    rowCount,
    truncated: rowCount > rows.length,
  };
}

// ─── Formulare ───────────────────────────────────────────────────────────────

function dataAttrs(el: Element): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(el.attribs ?? {})) {
    if (k.startsWith('data-')) out[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function labelFor($: CheerioAPI, field: Cheerio<Element>): string | undefined {
  const id = field.attr('id');
  if (id) {
    const byFor = cleanText($(`label[for="${id.replace(/"/g, '\\"')}"]`).first().text());
    if (byFor) return byFor;
  }
  const wrapped = cleanText(field.closest('label').first().text());
  if (wrapped) return wrapped;
  const group = cleanText(field.closest('.form-group, .mb-3, .row').find('label').first().text());
  return group || undefined;
}

function parseForm($: CheerioAPI, form: Cheerio<Element>, index: number, baseUrl: string, full: boolean): FormSummary {
  const method = (form.attr('method') ?? 'get').toLowerCase();
  const override = form.find('input[name="_method"]').first().attr('value');
  const fields: FormFieldSummary[] = [];
  const submitters: FormSummary['submitters'] = [];

  for (const el of form.find('input, select, textarea, button').toArray()) {
    const f = $(el);
    const tag = el.tagName.toLowerCase();
    const type = (f.attr('type') ?? (tag === 'button' ? 'submit' : tag === 'input' ? 'text' : '')).toLowerCase();
    const name = f.attr('name');

    if ((tag === 'button' || tag === 'input') && ['submit', 'image', 'button', 'reset'].includes(type)) {
      if (type === 'submit' || type === 'image') {
        submitters.push({ ...(name ? { name } : {}), ...(f.attr('value') ? { value: f.attr('value') } : {}), text: cleanText(f.text()) || (f.attr('value') ?? '') });
      }
      continue;
    }
    if (!name || name === '_method') continue;

    const field: FormFieldSummary = { name, tag, ...(tag === 'input' ? { type } : {}) };
    if (full && f.attr('id')) field.id = f.attr('id');
    const label = labelFor($, f);
    if (label) field.label = label;
    if (f.is('[required]')) field.required = true;
    if (f.is('[disabled]')) field.disabled = true;

    if (full) {
      if (tag === 'select') {
        const options = f.find('option').toArray();
        field.multiple = f.is('[multiple]') || undefined;
        field.optionCount = options.length;
        field.options = options.slice(0, 30).map((o) => ({
          value: $(o).attr('value') ?? cleanText($(o).text()),
          label: cleanText($(o).text()),
          ...($(o).is('[selected]') ? { selected: true } : {}),
        }));
        const selected = options.filter((o) => $(o).is('[selected]')).map((o) => $(o).attr('value') ?? '');
        if (selected.length > 0) field.value = selected.join(',');
      } else if (tag === 'textarea') {
        const v = f.text();
        if (v) field.value = v.length > 200 ? `${v.slice(0, 200)}…` : v;
      } else if (type === 'checkbox' || type === 'radio') {
        field.value = `${f.attr('value') ?? 'on'}${f.is('[checked]') ? ' (checked)' : ''}`;
      } else if (f.attr('value') !== undefined) {
        field.value = isSensitiveName(name) || type === 'password' ? '<redacted>' : f.attr('value');
      }
      const data = dataAttrs(el);
      if (data) field.data = data;
    }
    fields.push(field);
  }

  const action = form.attr('action');
  return {
    index,
    ...(form.attr('id') ? { id: form.attr('id') } : {}),
    ...(action !== undefined ? { action: toInternalPath(action, baseUrl) ?? action } : {}),
    method,
    httpMethod: (override ?? method).toLowerCase(),
    ...(form.attr('data-turbo') ? { turbo: form.attr('data-turbo') } : {}),
    fields,
    submitters,
    ...(full && dataAttrs(form.get(0)!) ? { data: dataAttrs(form.get(0)!) } : {}),
  };
}

// ─── Links, nachladbare URLs, Text ───────────────────────────────────────────

function collectLinks($: CheerioAPI, baseUrl: string, max: number): LinkSummary[] {
  const seen = new Set<string>();
  const out: LinkSummary[] = [];
  for (const a of $('a[href]').toArray()) {
    const path = toInternalPath($(a).attr('href'), baseUrl);
    if (!path) continue;
    const method = ($(a).attr('data-turbo-method') ?? $(a).attr('data-method'))?.toLowerCase();
    const key = `${method ?? 'get'} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = cleanText($(a).text()) || cleanText($(a).attr('title')) || cleanText($(a).attr('aria-label'));
    out.push({ text: text.slice(0, 80), path, ...(method && method !== 'get' ? { method } : {}) });
    if (out.length >= max) break;
  }
  return out;
}

const DATA_URL_ATTR = /^data-[\w-]*(url|href|route|path|src)$/;

function collectDataUrls($: CheerioAPI, baseUrl: string): string[] {
  const out = new Set<string>();
  for (const el of $('*').toArray()) {
    if (el.type !== 'tag') continue;
    for (const [k, v] of Object.entries((el as Element).attribs ?? {})) {
      if (DATA_URL_ATTR.test(k) || k === 'data-ajax--url') {
        out.add(`${k}=${toInternalPath(v, baseUrl) ?? v}`);
      }
    }
    if (out.size >= 300) break;
  }
  return [...out];
}

function extractText($: CheerioAPI, max: number): string {
  const body = $('body').clone();
  body.find('script, style, noscript, svg, template, nav, .navbar, footer, select, table, .modal, .dropdown-menu').remove();
  const text = readableText(body.get(0));
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// ─── Kleinkram ───────────────────────────────────────────────────────────────

function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
