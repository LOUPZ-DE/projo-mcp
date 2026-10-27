import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { ProjoError } from './errors.js';
import { csrfFromPage, isRedirect, type ProjoHttp, type ProjoPage, type ProjoResponse } from './http.js';
import { cleanText, extractHtmlFromJs, toInternalPath } from './util/dom.js';

/**
 * Browserähnliche Formular-Verarbeitung für Rails/simple_form:
 * Felder in Dokumentreihenfolge serialisieren (hidden, select, checkbox, textarea, `_method`,
 * `authenticity_token`), gezielt überschreiben, absenden und Validierungsfehler auslesen.
 *
 * Verschachtelte <form>-Tags (kommen in Projo vor) behandelt cheerio wie der Browser:
 * das innere Tag wird ignoriert, seine Felder gehören zum äußeren Formular.
 */

export interface FormControl {
  name: string;
  value: string;
  /** Würde der Browser dieses Feld ohne Override mitsenden? (checked, nicht disabled …) */
  successful: boolean;
}

export interface ParsedForm {
  action: string;
  /** effektive Methode inkl. `_method` (post/patch/put/delete/get) */
  httpMethod: string;
  controls: FormControl[];
  submitters: { name: string; value: string }[];
  /** data-remote="true" → rails-ujs schickt per XHR und erwartet JavaScript */
  remote: boolean;
  /**
   * Token für den X-CSRF-Token-Header – wie rails-ujs das globale Token aus `<meta name="csrf-token">`.
   * Das Formularfeld `authenticity_token` kann ein formularbezogenes Token für ein ANDERES Ziel sein
   * (projo verschachtelt Formulare) und würde allein abgelehnt.
   */
  csrfToken?: string;
}

/** Wert(e) je Feldname; `null` entfernt das Feld. */
export type FormOverrides = Record<string, string | string[] | null>;

export function extractForm($: CheerioAPI, selector: string, baseUrl: string): ParsedForm {
  const form = $(selector).first();
  if (form.length === 0) throw new ProjoError('drift_detected', `Formular „${selector}“ nicht gefunden – hat sich die Projo-Oberfläche geändert?`);
  const action = toInternalPath(form.attr('action') ?? '', baseUrl);
  if (!action) throw new ProjoError('drift_detected', `Formular „${selector}“ hat kein gültiges Ziel (action).`);
  const method = (form.attr('method') ?? 'get').toLowerCase();
  const controls: FormControl[] = [];
  const submitters: ParsedForm['submitters'] = [];

  for (const el of form.find('input, select, textarea, button').toArray()) {
    const f = $(el);
    const name = f.attr('name');
    const tag = el.tagName.toLowerCase();
    const type = (f.attr('type') ?? (tag === 'button' ? 'submit' : 'text')).toLowerCase();
    const disabled = f.is('[disabled]') || f.closest('fieldset[disabled]').length > 0;
    if (!name) continue;

    if ((tag === 'input' || tag === 'button') && ['submit', 'image', 'button', 'reset'].includes(type)) {
      if (type === 'submit' || type === 'image') submitters.push({ name, value: f.attr('value') ?? '' });
      continue;
    }
    if (tag === 'input' && type === 'file') continue;

    if (tag === 'select') {
      const options = f.find('option').toArray();
      const selected = options.filter((o) => $(o).is('[selected]') && !$(o).is('[disabled]'));
      const multiple = f.is('[multiple]');
      const chosen = selected.length > 0 ? selected : multiple ? [] : options.filter((o) => !$(o).is('[disabled]')).slice(0, 1);
      if (chosen.length === 0) controls.push({ name, value: '', successful: false });
      for (const o of chosen) controls.push({ name, value: $(o).attr('value') ?? $(o).text(), successful: !disabled });
      continue;
    }
    if (tag === 'textarea') {
      controls.push({ name, value: f.text(), successful: !disabled });
      continue;
    }
    if (type === 'checkbox' || type === 'radio') {
      controls.push({ name, value: f.attr('value') ?? 'on', successful: !disabled && f.is('[checked]') });
      continue;
    }
    controls.push({ name, value: f.attr('value') ?? '', successful: !disabled });
  }

  const override = controls.find((c) => c.name === '_method')?.value;
  return {
    action,
    httpMethod: (override ?? method).toLowerCase(),
    controls,
    submitters,
    remote: form.attr('data-remote') === 'true',
    csrfToken: csrfFromPage($) ?? controls.find((c) => c.name === 'authenticity_token')?.value,
  };
}

/**
 * Serialisiert wie ein Browser. Overrides ersetzen ein Feld an seiner ersten Position
 * (Rails-Checkbox-Muster hidden "0" + checkbox "1" → genau ein Wert).
 * `strict` (Default): Overrides für Felder, die es im Formular nicht gibt → drift_detected.
 */
export function serializeForm(form: ParsedForm, overrides: FormOverrides = {}, opts: { submitter?: string; strict?: boolean } = {}): [string, string][] {
  const out: [string, string][] = [];
  const handled = new Set<string>();
  const emit = (name: string, v: string | string[] | null) => {
    if (v === null) return;
    for (const value of Array.isArray(v) ? v : [v]) out.push([name, value]);
  };

  for (const c of form.controls) {
    if (Object.hasOwn(overrides, c.name)) {
      if (!handled.has(c.name)) {
        handled.add(c.name);
        emit(c.name, overrides[c.name]!);
      }
      continue;
    }
    if (c.successful) out.push([c.name, c.value]);
  }

  const missing = Object.keys(overrides).filter((n) => !handled.has(n));
  if (missing.length > 0 && opts.strict !== false) {
    throw new ProjoError('drift_detected', `Erwartete Formularfelder fehlen: ${missing.join(', ')}`, { missing });
  }
  for (const n of missing) emit(n, overrides[n]!);

  if (opts.submitter) {
    const s = form.submitters.find((x) => x.name === opts.submitter || x.value === opts.submitter);
    if (s) out.push([s.name, s.value]);
  }
  return out;
}

/** Validierungs-/Fehlermeldungen aus einer (re-)gerenderten Seite. */
export function parseFormErrors($: CheerioAPI): string[] {
  const sel = '.invalid-feedback, .error_notification, .alert-danger, #error_explanation li, .has-error .help-block, .form-group-invalid .invalid-feedback, .text-danger';
  return [...new Set($(sel).toArray().map((e) => cleanText($(e).text())).filter(Boolean))];
}

export interface SubmitResult {
  response: ProjoResponse;
  /** Request angenommen (2xx/3xx) und keine Fehlermeldungen in der Antwort */
  ok: boolean;
  errors: string[];
  /** HTML der Antwort (bei JS-Antworten das eingebettete HTML) */
  html: string;
}

export async function submitForm(
  http: ProjoHttp,
  opts: { page: ProjoPage; selector: string; overrides?: FormOverrides; submitter?: string; strict?: boolean; xhr?: boolean },
): Promise<SubmitResult> {
  const form = extractForm(opts.page.$, opts.selector, http.baseUrl);
  const fields = serializeForm(form, opts.overrides, { submitter: opts.submitter, strict: opts.strict });
  const xhr = opts.xhr ?? form.remote;
  const response = await http.send(form.httpMethod === 'get' ? 'GET' : 'POST', form.action, { form: fields, xhr, csrfToken: form.csrfToken });
  const html = /javascript/i.test(response.contentType) ? extractHtmlFromJs(response.body) : response.body;
  const errors = html ? parseFormErrors(cheerio.load(html)) : [];
  const accepted = (response.status >= 200 && response.status < 300) || isRedirect(response.status);
  return { response, ok: accepted && errors.length === 0, errors: accepted ? errors : errors.length > 0 ? errors : [`HTTP ${response.status}`], html };
}
