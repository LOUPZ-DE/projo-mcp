import type { CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { ProjoError } from '../errors.js';
import { parseDuration, parseGermanDate, parseGermanNumber, roundHours } from '../util/de.js';
import { cleanText, readableText } from '../util/dom.js';

/**
 * Parser der Zeiterfassungs-Seiten (Persönlicher Bereich → Zeiten). Grundlage: docs/projo-discovery.md.
 * Jeder Parser prüft Erkennungsmerkmale und meldet Abweichungen als `drift_detected` statt still leer zu liefern.
 */

export interface Booking {
  /** projo-Buchungs-ID (nur aus der Tagesansicht) */
  id?: string;
  hours: number;
  /** "<Vertragscode> - <Leistung>" wie in projo, von projo gekürzte Namen aus dem title vervollständigt */
  label: string;
  /** Vertragscode/Projekt, z. B. "1000-Projekt-01" */
  contract?: string;
  /** voller Leistungsname (aus dem title-Attribut) */
  task?: string;
  description?: string;
  /** Zeiten gesperrt (nur noch die Beschreibung ist änderbar) */
  locked?: boolean;
}

export interface DayView {
  date: string;
  bookings: Booking[];
  totalHours: number;
  /**
   * Tag gesperrt (Hinweis „… gesperrt“ im Kopf bzw. kein Button „Zeitbuchung“) – projo nimmt neue Buchungen
   * serverseitig trotzdem an, deshalb vorher prüfen. Nur aus der Tagesansicht, nicht aus JS-Antworten nach Writes.
   */
  lockNote?: string;
}

function splitLabel(label: string): { contract?: string; rest: string } {
  const i = label.indexOf(' - ');
  return i > 0 ? { contract: label.slice(0, i), rest: label.slice(i + 3) } : { rest: label };
}

/** projo kürzt lange Namen in der Anzeige in der Mitte („ ... “) – vollständig steht der Name nur im title-Attribut. */
export function completeLabel(label: string, task: string | undefined): string {
  const { contract } = splitLabel(label);
  return label.includes(' ... ') && contract && task ? `${contract} - ${task}` : label;
}

function bookingFromCells($: CheerioAPI, row: ReturnType<CheerioAPI>, id?: string): Booking | undefined {
  const durationEl = row.find('[data-bip-attribute="duration_in_hour_min_str"]').first();
  const durationText = durationEl.attr('data-bip-value') ?? (durationEl.length ? cleanText(durationEl.text()) : cleanText(row.children('td').first().text()));
  const hours = parseDuration(durationText);
  const labelEl = row.find('span.label').first();
  const label = cleanText(labelEl.text());
  if (hours === undefined || !label) return undefined;
  const descEl = row.find('[data-bip-attribute="description"]').first();
  const description = descEl.length ? cleanText(descEl.text()) : cleanText(row.children('td').eq(2).text());
  const task = labelEl.attr('title') ? cleanText(labelEl.attr('title')) : undefined;
  const { contract } = splitLabel(label);
  return {
    ...(id ? { id } : {}),
    hours: roundHours(hours),
    label: completeLabel(label, task),
    ...(contract ? { contract } : {}),
    ...(task ? { task } : {}),
    ...(description ? { description } : {}),
    ...(id && durationEl.length === 0 ? { locked: true } : {}),
  };
}

/**
 * Kopf der Tagesansicht genau dieses Datums: die Datumsauswahl verweist auf `/app/dates/<datum>`.
 * Einziges sicheres Merkmal für Tage ohne Buchung in gesperrten Zeiträumen – dort fehlt der Button „Zeitbuchung“.
 */
function isDayHeader($: CheerioAPI, date: string): boolean {
  const href = $('#datepicker').first().attr('href') ?? '';
  let url = href;
  try {
    url = decodeURIComponent(href);
  } catch {
    // unvollständig kodiert – roh vergleichen
  }
  return url.includes(`current_date=${date}`) && url.includes(`/app/dates/${date}`);
}

/** Tagesansicht `/app/dates/<datum>` – auch das HTML aus JS-Antworten nach Writes (#show wird neu gerendert). */
export function parseDayView($: CheerioAPI, date: string): DayView {
  const rows = $('tr[id^="booking-"]').toArray();
  const header = isDayHeader($, date);
  const looksLikeDay = rows.length > 0 || $('a[href*="/app/bookings/new"]').length > 0 || $('#sortable-parent').length > 0 || header;
  if (!looksLikeDay) throw new ProjoError('drift_detected', 'Die Tagesansicht von projo hat ein unerwartetes Format.');
  // Dauer-Felder ohne erkennbare Buchungszeile → Zeilenformat geändert; nicht still „keine Buchungen“ melden
  if ($('[data-bip-attribute="duration_in_hour_min_str"]').filter((_, el) => $(el).closest('tr[id^="booking-"]').length === 0).length > 0) {
    throw new ProjoError('drift_detected', 'Die Buchungszeilen der Tagesansicht haben ein unerwartetes Format.');
  }

  const bookings: Booking[] = [];
  for (const r of rows) {
    const row = $(r);
    const id = (row.attr('data-row-id') ?? row.attr('id')?.replace(/^booking-/, '')) || undefined;
    const b = bookingFromCells($, row, id);
    if (!b) throw new ProjoError('drift_detected', `Buchungszeile ${id ?? '?'} ließ sich nicht lesen.`);
    bookings.push(b);
  }
  // Sperre: Hinweis im Kopf; ohne Hinweis zur Sicherheit auch ein Tageskopf ohne Button „Zeitbuchung“ (Kopien zählen nicht)
  const lockHint = $('#show h2 [title*="gesperrt"]').first().attr('title');
  const lockNote = lockHint
    ? cleanText(lockHint)
    : header && $('a[href*="/app/bookings/new?date="]').length === 0
      ? 'In projo gibt es für diesen Tag keinen Button „Zeitbuchung“ – vermutlich gesperrt.'
      : undefined;
  return { date, bookings, totalHours: roundHours(bookings.reduce((s, b) => s + b.hours, 0)), ...(lockNote ? { lockNote } : {}) };
}

export interface MonthSummaryItem {
  label: string;
  hours: number;
  /** Nebenwert, z. B. "Sollstunden (ab morgen)" oder "AZ-Konto am 01.10.2026 morgens" */
  detail?: { label: string; hours: number };
}

export interface MonthView {
  /** z. B. "Oktober 2026" */
  title?: string;
  summary: MonthSummaryItem[];
  days: { date: string; bookings: Booking[]; totalHours: number; balance?: string }[];
}

/** Monatsansicht `/app/months?date=` – Kopfkarten (Soll/Ist/AZ-Konto) + Buchungen je Tag (ohne IDs). */
export function parseMonthView($: CheerioAPI, year: number): MonthView {
  const summary: MonthSummaryItem[] = [];
  for (const col of $('#over_time .col').toArray()) {
    const c = $(col);
    const hours = parseDuration(cleanText(c.find('h3').first().text()));
    const labelEl = c.children('span.text-secondary').first().clone();
    labelEl.find('span').remove();
    const label = cleanText(labelEl.text());
    if (hours === undefined || !label) continue;
    const small = readableText(c.find('.small').first().get(0));
    const dm = /^([+−-]?\d{1,4}:\d{2}\s*h)\s+(.+)$/.exec(small);
    const detailHours = dm ? parseDuration(dm[1]) : undefined;
    summary.push({
      label,
      hours: roundHours(hours),
      ...(dm && detailHours !== undefined ? { detail: { label: dm[2]!, hours: roundHours(detailHours) } } : {}),
    });
  }

  const rows = $('tr.js-click-row[data-href*="/app/dates/"]').toArray();
  if (summary.length === 0 && rows.length === 0) throw new ProjoError('drift_detected', 'Die Monatsansicht von projo hat ein unerwartetes Format.');

  const days: MonthView['days'] = [];
  for (const r of rows) {
    const row = $(r);
    const date = /\/app\/dates\/(\d{4}-\d{2}-\d{2})/.exec(row.attr('data-href') ?? '')?.[1] ?? parseGermanDate(cleanText(row.children('td').first().text()), year);
    if (!date) continue;
    const bookings: Booking[] = [];
    for (const br of row.find('table.slim-table tr').toArray() as Element[]) {
      const cells = $(br).children('td');
      if (cells.length < 2) continue;
      const b = bookingFromCells($, $(br));
      if (b) bookings.push(b);
    }
    const balance = cleanText(row.children('td').eq(2).text()) || undefined;
    if (bookings.length > 0 || balance) {
      days.push({ date, bookings, totalHours: roundHours(bookings.reduce((s, b) => s + b.hours, 0)), ...(balance ? { balance } : {}) });
    }
  }
  const title = cleanText($('#datepicker').first().text()) || undefined;
  return { ...(title ? { title } : {}), summary, days };
}

export interface TaskOptionRaw {
  taskId: string;
  /** voller Leistungsname, wie im Dropdown (ohne Vertragscode) */
  name: string;
  leafId?: string;
}

export interface ContractInfo {
  code: string;
  title?: string;
  /** projo-ID des Vertrags (treaty); beim aktiven Vertrag aus dem Link „alle Leistungen“ */
  treatyId?: string;
  active: boolean;
}

export interface BookingFormInfo {
  /** Leistungen des aktuell gefilterten Vertrags (volle Namen) */
  tasks: TaskOptionRaw[];
  /** alle Verträge aus „Filtern auf Vertrag“ (je Person verschieden) */
  contracts: ContractInfo[];
  /** Vertrag, dessen Leistungen `tasks` zeigt */
  activeContract?: string;
  activeTreatyId?: string;
}

/** Optionen eines Leistungs-Selects (Buchungsformular oder Antwort des Vertragsfilters). */
export function parseTaskOptions($: CheerioAPI): TaskOptionRaw[] {
  return $('select[name="time_tracking_booking[task_id]"]')
    .first()
    .find('option')
    .toArray()
    .map((o) => {
      const leafId = /\/leaves\/(\d+)/.exec($(o).attr('data-time-tracking-leaf-url') ?? '')?.[1];
      return { taskId: ($(o).attr('value') ?? '').trim(), name: cleanText($(o).text()), ...(leafId ? { leafId } : {}) };
    })
    .filter((t) => /^\d+$/.test(t.taskId));
}

/** Formular „Zeitbuchung“ `/app/bookings/new?date=` */
export function parseBookingForm($: CheerioAPI): BookingFormInfo {
  if ($('#new_time_tracking_booking select[name="time_tracking_booking[task_id]"]').length === 0) {
    throw new ProjoError('drift_detected', 'Das Buchungsformular von projo hat ein unerwartetes Format (Leistungsauswahl fehlt).');
  }
  const tasks = parseTaskOptions($);
  // Der aktive Vertrag trägt im Chip keine ID – die steht im Link „alle Leistungen“ (structure_bookings?treaty_id=…)
  const activeTreatyId = /treaty_id=(\d+)/.exec($('a[href*="structure_bookings/new"]').first().attr('href') ?? '')?.[1];

  const contracts: ContractInfo[] = $('.filter_of_treaties a[href*="filter_treaty"]')
    .toArray()
    .map((a) => {
      const inner = $(a).find('span[title]').first();
      const active = $(a).closest('.highlight').length > 0;
      const treatyId = /filtered_treaty_id=(\d+)/.exec($(a).attr('href') ?? '')?.[1] ?? (active ? activeTreatyId : undefined);
      return {
        code: cleanText(inner.text() || $(a).text()),
        ...(inner.attr('title') ? { title: cleanText(inner.attr('title')) } : {}),
        ...(treatyId ? { treatyId } : {}),
        active,
      };
    })
    .filter((c) => c.code);
  const activeContract = contracts.find((c) => c.active)?.code;
  return { tasks, contracts, ...(activeContract ? { activeContract } : {}), ...(activeTreatyId ? { activeTreatyId } : {}) };
}

/** Auswahlliste aller buchbaren Leistungen aus `edit_task` (lange Namen von projo in der Mitte mit „ ... “ gekürzt). */
export function parseAllTasks($: CheerioAPI): { taskId: string; label: string; contract?: string }[] {
  return $('option[data-url*="update_task"]')
    .toArray()
    .map((o) => {
      const taskId = $(o).attr('value') ?? /task_id=(\d+)/.exec($(o).attr('data-url') ?? '')?.[1] ?? '';
      const label = cleanText($(o).text());
      const { contract } = splitLabel(label);
      return { taskId, label, ...(contract ? { contract } : {}) };
    })
    .filter((t) => /^\d+$/.test(t.taskId));
}

export interface TaskTreeNode {
  /** Gliederungsnummer, z. B. "2.1.1.1.7" */
  number?: string;
  /** Ebene im Baum, 1 = oberste */
  level: number;
  name: string;
  /** Status-Badge, z. B. "laufend", "nicht abrechenbar", "fertig" */
  status?: string;
  /** nur bei buchbaren Leistungen (Link „leaf_chosen“) – dieselbe ID wie `leafId` im Leistungs-Select */
  leafId?: string;
}

/**
 * Leistungsbaum eines Vertrags („alle Leistungen“, `GET /app/structure_bookings/new?treaty_id=`, nur lesend):
 * Gliederung mit Nummern, vollen Namen und Status. Nicht buchbare Zeilen (ausgeblendet, durchgestrichen) haben
 * keinen Link und damit keine leafId, bleiben aber als Ebene im Pfad erhalten.
 */
export function parseTaskTree($: CheerioAPI): TaskTreeNode[] {
  const table = $('table#treaty_tree');
  if (table.length === 0) throw new ProjoError('drift_detected', 'Die Leistungsübersicht („alle Leistungen“) von projo hat ein unerwartetes Format.');
  const nodes: TaskTreeNode[] = [];
  for (const tr of table.find('tbody tr').toArray()) {
    const td = $(tr).children('td');
    const name = cleanText(td.eq(1).text());
    if (!name) continue;
    const number = cleanText(td.eq(0).text());
    // Ebene aus der Nummer, sonst aus der Einrückung (0.5em, 1.7em, 2.9em, … je Ebene +1.2em)
    const pad = Number(/padding-left:\s*([\d.]+)em/.exec(td.eq(1).attr('style') ?? '')?.[1] ?? '0.5');
    const level = /^\d+(\.\d+)*$/.test(number) ? number.split('.').length : Math.max(1, Math.round((pad - 0.5) / 1.2) + 1);
    const leafId = /structure_bookings\/(\d+)\/leaf_chosen/.exec(td.eq(1).find('a[href*="leaf_chosen"]').attr('href') ?? '')?.[1];
    const status = cleanText(td.eq(2).text());
    nodes.push({ ...(number ? { number } : {}), level, name, ...(status ? { status } : {}), ...(leafId ? { leafId } : {}) });
  }
  return nodes;
}

export interface HoursAnalysis {
  projects: { project: string; title?: string; hours: number; percent?: number }[];
  absences: { type: string; hours: number }[];
  totals: Record<string, number>;
}

/** „Stunden pro Projekt“ `/app/bookings_analysis?date=&end_date=` */
export function parseHoursAnalysis($: CheerioAPI): HoursAnalysis {
  const table = $('table').filter((_, t) => /geleistete Stunden pro Projekt/.test($(t).text())).first();
  if (table.length === 0) throw new ProjoError('drift_detected', 'Die Auswertung „Stunden pro Projekt“ hat ein unerwartetes Format.');
  const out: HoursAnalysis = { projects: [], absences: [], totals: {} };
  let section: 'projects' | 'absences' | 'other' = 'projects';
  for (const tr of table.find('tr').toArray()) {
    const row = $(tr);
    const th = row.children('th');
    if (th.length > 0) {
      const label = readableText(th.first().get(0));
      const hours = parseDuration(readableText(th.eq(1).get(0)));
      if (/^geleistete Stunden pro Projekt/.test(label)) {
        if (hours !== undefined) out.totals['Projektstunden'] = roundHours(hours);
        section = 'projects';
      } else if (/^Abwesenheiten/.test(label)) {
        if (hours !== undefined) out.totals['Abwesenheiten'] = roundHours(hours);
        section = 'absences';
      } else {
        if (hours !== undefined) out.totals[label] = roundHours(hours);
        section = 'other';
      }
      continue;
    }
    const cells = row.children('td');
    const name = cleanText(cells.first().find('span.label').first().text()) || cleanText(cells.first().text());
    const hours = parseDuration(cleanText(cells.eq(1).text()));
    if (!name || hours === undefined) continue;
    if (section === 'projects') {
      const title = cells.first().find('span[title]').first().attr('title');
      const percent = parseGermanNumber(cleanText(cells.eq(2).text()));
      out.projects.push({ project: name, ...(title ? { title } : {}), hours: roundHours(hours), ...(percent !== undefined ? { percent } : {}) });
    } else if (section === 'absences') {
      out.absences.push({ type: name, hours: roundHours(hours) });
    }
  }
  return out;
}
