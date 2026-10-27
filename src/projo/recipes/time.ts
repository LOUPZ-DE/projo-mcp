import * as cheerio from 'cheerio';
import { ProjoError } from '../errors.js';
import { submitForm } from '../form.js';
import { csrfFromPage } from '../http.js';
import { extractHtmlFromJs } from '../util/dom.js';
import { log } from '../../util/log.js';
import {
  parseAllTasks,
  parseBookingForm,
  parseDayView,
  parseHoursAnalysis,
  parseMonthView,
  parseTaskOptions,
  type Booking,
  type BookingFormInfo,
  type ContractInfo,
  type DayView,
  type HoursAnalysis,
  type MonthView,
} from '../pages/time.js';
import type { ProjoSessionManager, ProjoUserContext } from '../session.js';
import {
  addDays,
  assertBookableHours,
  assertIsoDate,
  daysInclusive,
  formatDuration,
  monthsBetween,
  roundHours,
  toGermanDate,
  todayBerlin,
} from '../util/de.js';

/**
 * Zeiterfassung – feste, „trainierte“ Abläufe (Mitschnitt siehe docs/projo-discovery.md).
 * projo validiert serverseitig kaum (Buchung ohne Leistung/mit 0:00 h wird angelegt, ungültige Dauer → 204),
 * deshalb: Eingaben hier streng prüfen und jedes Ergebnis durch erneutes Lesen bestätigen.
 */

const MAX_RANGE_DAYS = 92;
/** bis zu so vielen Tagen wird tageweise gelesen (mit Buchungs-IDs), darüber per Monatsansicht */
const DAY_MODE_MAX_DAYS = 10;
const OPTIONS_TTL_MS = 10 * 60_000;

export interface TaskOption {
  taskId: string;
  /** Vertragscode, z. B. "1000-Projekt-01" */
  contract?: string;
  /** Projekt-/Vertragstitel, z. B. "Neubau Musterschule" */
  contractTitle?: string;
  /** Leistungsname ohne Vertragscode */
  name: string;
  /** "<Vertragscode> - <Leistung>" wie in der Tagesansicht */
  label: string;
  /** false = Name aus der Gesamtliste, dort kürzt projo lange Namen in der Mitte („ ... “) */
  complete: boolean;
}

interface UserOptionsCache {
  form?: { at: number; info: BookingFormInfo; csrf?: string };
  /** Leistungen je Vertrag (treatyId → Liste mit vollen Namen) */
  contracts: Map<string, { at: number; tasks: TaskOption[] }>;
  /** Gesamtliste aller buchbaren Leistungen */
  all?: { at: number; tasks: TaskOption[]; source: 'gesamtliste' | 'je-vertrag' };
}
const caches = new Map<string, UserOptionsCache>();

const cacheOf = (email: string): UserOptionsCache => {
  let c = caches.get(email);
  if (!c) {
    c = { contracts: new Map() };
    caches.set(email, c);
  }
  return c;
};
const fresh = (at: number | undefined) => at !== undefined && Date.now() - at < OPTIONS_TTL_MS;

const dayPath = (uid: string, date: string) => `/app/dates/${date}?user_id=${uid}`;

async function readDay(ctx: ProjoUserContext, uid: string, date: string): Promise<{ view: DayView; csrf?: string }> {
  const page = await ctx.http.getPage(dayPath(uid, date));
  return { view: parseDayView(page.$, date), csrf: csrfFromPage(page.$) };
}

function validateRange(from: string, to: string): void {
  assertIsoDate(from, 'from');
  assertIsoDate(to, 'to');
  if (to < from) throw new ProjoError('invalid_input', '„to“ liegt vor „from“.');
  if (daysInclusive(from, to) > MAX_RANGE_DAYS) throw new ProjoError('invalid_input', `Zeitraum zu lang (max. ${MAX_RANGE_DAYS} Tage).`);
}

/** Lange projo-Labels sind in der Mitte gekürzt („Terminplan ... software“) – Vergleich tolerant. */
export function labelMatches(full: string, maybeTruncated: string): boolean {
  if (full === maybeTruncated) return true;
  const i = maybeTruncated.indexOf(' ... ');
  if (i < 0) return false;
  return full.startsWith(maybeTruncated.slice(0, i)) && full.endsWith(maybeTruncated.slice(i + 5));
}

/** Gehört eine Buchung (Tagesansicht) zu dieser Leistung? Vorrang hat der volle Name aus dem title-Attribut. */
export function bookingMatchesTask(b: Booking, t: TaskOption): boolean {
  if (b.task && (labelMatches(b.task, t.name) || labelMatches(t.name, b.task))) return true;
  return labelMatches(b.label, t.label) || labelMatches(t.label, b.label);
}

const toOption = (raw: { taskId: string; name: string }, contract: string | undefined, contractTitle?: string): TaskOption => ({
  taskId: raw.taskId,
  ...(contract ? { contract } : {}),
  ...(contractTitle ? { contractTitle } : {}),
  name: raw.name,
  label: contract ? `${contract} - ${raw.name}` : raw.name,
  complete: !raw.name.includes(' ... '),
});

// ─── Lesen ───────────────────────────────────────────────────────────────────

export interface TimeEntriesResult {
  from: string;
  to: string;
  source: 'tagesansicht' | 'monatsansicht';
  days: { date: string; bookings: Booking[]; totalHours: number; balance?: string }[];
  totalHours: number;
  months?: { month: string; title?: string; summary: MonthView['summary'] }[];
}

export async function timeEntries(sessions: ProjoSessionManager, email: string, from: string, to: string): Promise<TimeEntriesResult> {
  validateRange(from, to);
  return sessions.withUser(email, async (ctx) => {
    const uid = await sessions.userId(ctx);
    if (daysInclusive(from, to) <= DAY_MODE_MAX_DAYS) {
      const days: TimeEntriesResult['days'] = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const { view } = await readDay(ctx, uid, d);
        if (view.bookings.length > 0) days.push(view);
      }
      return { from, to, source: 'tagesansicht', days, totalHours: roundHours(days.reduce((s, d) => s + d.totalHours, 0)) };
    }
    const days: TimeEntriesResult['days'] = [];
    const months: NonNullable<TimeEntriesResult['months']> = [];
    for (const m of monthsBetween(from, to)) {
      const page = await ctx.http.getPage(`/app/months?date=${m}&user_id=${uid}`);
      const mv = parseMonthView(page.$, Number(m.slice(0, 4)));
      months.push({ month: m.slice(0, 7), ...(mv.title ? { title: mv.title } : {}), summary: mv.summary });
      days.push(...mv.days.filter((d) => d.date >= from && d.date <= to && d.bookings.length > 0));
    }
    return { from, to, source: 'monatsansicht', days, totalHours: roundHours(days.reduce((s, d) => s + d.totalHours, 0)), months };
  });
}

export async function hoursSummary(sessions: ProjoSessionManager, email: string, from: string, to: string): Promise<HoursAnalysis & { from: string; to: string }> {
  assertIsoDate(from, 'from');
  assertIsoDate(to, 'to');
  if (to < from) throw new ProjoError('invalid_input', '„to“ liegt vor „from“.');
  return sessions.withUser(email, async (ctx) => {
    const uid = await sessions.userId(ctx);
    const page = await ctx.http.getPage(`/app/bookings_analysis?user_id=${uid}&date=${toGermanDate(from)}&end_date=${toGermanDate(to)}`);
    return { from, to, ...parseHoursAnalysis(page.$) };
  });
}

/** Jüngste Buchung bis `date` (Schlüssel zur Gesamtliste aller Leistungen über edit_task). */
async function findRecentBooking(ctx: ProjoUserContext, uid: string, date: string): Promise<{ id: string; date: string } | undefined> {
  const today = await readDay(ctx, uid, date);
  const own = today.view.bookings.find((b) => b.id);
  if (own?.id) return { id: own.id, date };
  let month = `${date.slice(0, 7)}-01`;
  for (let i = 0; i < 3; i++) {
    const page = await ctx.http.getPage(`/app/months?date=${month}&user_id=${uid}`);
    const mv = parseMonthView(page.$, Number(month.slice(0, 4)));
    const day = [...mv.days].reverse().find((d) => d.date <= date && d.bookings.length > 0);
    if (day) {
      const { view } = await readDay(ctx, uid, day.date);
      const b = view.bookings.find((x) => x.id);
      if (b?.id) return { id: b.id, date: day.date };
    }
    month = `${addDays(month, -1).slice(0, 7)}-01`;
  }
  return undefined;
}

/** Buchungsformular: Verträge der Person + Leistungen des gerade gefilterten Vertrags. */
async function loadForm(ctx: ProjoUserContext, uid: string, date: string): Promise<{ info: BookingFormInfo; csrf?: string }> {
  const cache = cacheOf(ctx.record.mcpEmail);
  if (cache.form && fresh(cache.form.at)) return cache.form;
  const page = await ctx.http.getPage(`/app/bookings/new?date=${date}&user_id=${uid}`);
  cache.form = { at: Date.now(), info: parseBookingForm(page.$), csrf: csrfFromPage(page.$) };
  const info = cache.form.info;
  if (info.activeContract && info.activeTreatyId) {
    const title = info.contracts.find((c) => c.active)?.title;
    cache.contracts.set(info.activeTreatyId, { at: Date.now(), tasks: info.tasks.map((t) => toOption(t, info.activeContract, title)) });
  }
  return cache.form;
}

/**
 * Leistungen von Verträgen mit vollen Namen – wie der Klick auf den Vertrags-Chip in der Oberfläche:
 * Filter je Vertrag umschalten (PATCH filter_treaty), Liste aus der JS-Antwort lesen und am Ende den
 * Filter der Person genau einmal auf den vorherigen Stand zurückstellen. Ergebnisse werden gecacht.
 */
async function loadContractsTasks(ctx: ProjoUserContext, uid: string, date: string, contracts: ContractInfo[]): Promise<TaskOption[]> {
  const cache = cacheOf(ctx.record.mcpEmail);
  const { info, csrf } = await loadForm(ctx, uid, date);
  const out: TaskOption[] = [];
  const todo: ContractInfo[] = [];
  for (const c of contracts) {
    if (!c.treatyId) continue;
    const hit = cache.contracts.get(c.treatyId);
    if (hit && fresh(hit.at)) out.push(...hit.tasks);
    else if (c.treatyId === info.activeTreatyId) {
      const tasks = info.tasks.map((t) => toOption(t, c.code, c.title));
      cache.contracts.set(c.treatyId, { at: Date.now(), tasks });
      out.push(...tasks);
    } else todo.push(c);
  }
  if (todo.length === 0) return out;
  if (!csrf) throw new ProjoError('drift_detected', 'CSRF-Token des Buchungsformulars nicht gefunden.');

  const filterPath = (treatyId?: string) => `/app/dates/${date}/filter_treaty?${treatyId ? `filtered_treaty_id=${treatyId}&` : ''}user_id=${uid}`;
  try {
    for (const c of todo) {
      const res = await ctx.http.send('PATCH', filterPath(c.treatyId), { xhr: true, csrfToken: csrf });
      if (res.status >= 400) throw new ProjoError('projo_unavailable', `projo hat den Vertragsfilter abgelehnt (HTTP ${res.status}).`);
      const tasks = parseTaskOptions(cheerio.load(extractHtmlFromJs(res.body))).map((t) => toOption(t, c.code, c.title));
      cache.contracts.set(c.treatyId!, { at: Date.now(), tasks });
      out.push(...tasks);
    }
  } finally {
    // Filter der Person immer wiederherstellen (vorher aktiver Vertrag bzw. kein Filter)
    try {
      await ctx.http.send('PATCH', filterPath(info.activeTreatyId), { xhr: true, csrfToken: csrf });
    } catch (err) {
      log('warn', 'projo: Vertragsfilter konnte nicht zurückgestellt werden', { user: ctx.record.mcpEmail, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

/** Alle buchbaren Leistungen: schnell über die Gesamtliste (edit_task), sonst Vertrag für Vertrag. */
async function loadAllTasks(ctx: ProjoUserContext, uid: string, date: string): Promise<{ tasks: TaskOption[]; source: 'gesamtliste' | 'je-vertrag' }> {
  const cache = cacheOf(ctx.record.mcpEmail);
  if (cache.all && fresh(cache.all.at)) return cache.all;
  const recent = await findRecentBooking(ctx, uid, date);
  let tasks: TaskOption[] = [];
  let source: 'gesamtliste' | 'je-vertrag' = 'gesamtliste';
  if (recent) {
    const page = await ctx.http.getPage(`/app/bookings/${recent.id}/edit_task?date=${recent.date}&user_id=${uid}`, { xhr: true });
    const titles = new Map((await loadForm(ctx, uid, date)).info.contracts.map((c) => [c.code, c.title]));
    tasks = parseAllTasks(page.$).map((t) => {
      const name = t.contract ? t.label.slice(t.contract.length + 3) : t.label;
      return toOption({ taskId: t.taskId, name }, t.contract, t.contract ? titles.get(t.contract) : undefined);
    });
  }
  if (tasks.length === 0) {
    source = 'je-vertrag';
    tasks = await loadContractsTasks(ctx, uid, date, (await loadForm(ctx, uid, date)).info.contracts);
  }
  // volle Namen aus bereits geladenen Vertragslisten haben Vorrang vor gekürzten
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  for (const entry of cache.contracts.values()) for (const t of entry.tasks) byId.set(t.taskId, t);
  cache.all = { at: Date.now(), tasks: [...byId.values()], source };
  return cache.all;
}

const normalize = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss');

function findContract(info: BookingFormInfo, wanted: string): ContractInfo {
  const w = normalize(wanted.trim());
  const c =
    info.contracts.find((x) => normalize(x.code) === w || x.treatyId === wanted.trim()) ??
    info.contracts.find((x) => normalize(x.code).startsWith(w) || (x.title && normalize(x.title) === w));
  if (!c) {
    throw new ProjoError('invalid_input', `Vertrag „${wanted}“ nicht gefunden. Verfügbar: ${info.contracts.map((x) => x.code).join(', ')}`);
  }
  return c;
}

export interface TimeOptionsResult {
  date: string;
  /** Verträge der Person (Chips „Filtern auf Vertrag“) */
  contracts: { code: string; title?: string; active: boolean }[];
  /** Vertrag, auf den sich `tasks` bezieht (bei contract-Abfrage oder ohne query) */
  contract?: string;
  source: 'vertrag' | 'gesamtliste' | 'je-vertrag';
  tasks: TaskOption[];
  matches: number;
}

export async function timeOptions(
  sessions: ProjoSessionManager,
  email: string,
  opts: { date?: string; query?: string; contract?: string; limit?: number },
): Promise<TimeOptionsResult> {
  const date = opts.date ? assertIsoDate(opts.date) : todayBerlin();
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  return sessions.withUser(email, async (ctx) => {
    const uid = await sessions.userId(ctx);
    const { info } = await loadForm(ctx, uid, date);
    const contracts = info.contracts.map((c) => ({ code: c.code, ...(c.title ? { title: c.title } : {}), active: c.active }));
    const words = normalize(opts.query ?? '').split(/\s+/).filter(Boolean);
    const match = (t: TaskOption) => words.every((w) => normalize(`${t.label} ${t.contractTitle ?? ''}`).includes(w));

    let pool: TaskOption[];
    let source: TimeOptionsResult['source'];
    let contract: string | undefined;
    if (opts.contract) {
      const c = findContract(info, opts.contract);
      pool = await loadContractsTasks(ctx, uid, date, [c]);
      source = 'vertrag';
      contract = c.code;
    } else if (words.length > 0) {
      const all = await loadAllTasks(ctx, uid, date);
      pool = all.tasks;
      source = all.source;
      // In gekürzten Namen der Gesamtliste fehlt der Mittelteil → ohne Treffer volle Listen aller Verträge laden
      if (!pool.some(match) && pool.some((t) => !t.complete)) {
        pool = await loadContractsTasks(ctx, uid, date, info.contracts);
        source = 'je-vertrag';
        const cache = cacheOf(ctx.record.mcpEmail);
        const byId = new Map((cache.all?.tasks ?? []).map((t) => [t.taskId, t]));
        for (const t of pool) byId.set(t.taskId, t);
        cache.all = { at: Date.now(), tasks: [...byId.values()], source: 'je-vertrag' };
      }
    } else {
      const title = info.contracts.find((c) => c.active)?.title;
      pool = info.tasks.map((t) => toOption(t, info.activeContract, title));
      source = 'vertrag';
      contract = info.activeContract;
    }
    const matches = pool.filter(match);
    return { date, contracts, ...(contract ? { contract } : {}), source, tasks: matches.slice(0, limit), matches: matches.length };
  });
}

/** taskId → Leistung; prüft, dass die Person sie buchen kann (projo selbst prüft das nicht). */
async function resolveTask(ctx: ProjoUserContext, uid: string, date: string, taskId: string): Promise<TaskOption> {
  if (!/^\d+$/.test(taskId)) throw new ProjoError('invalid_input', 'taskId muss die numerische ID einer Leistung aus projo_time_options sein.');
  const cache = cacheOf(ctx.record.mcpEmail);
  const known = () => {
    for (const entry of cache.contracts.values()) {
      const t = entry.tasks.find((x) => x.taskId === taskId);
      if (t) return t;
    }
    return cache.all?.tasks.find((x) => x.taskId === taskId);
  };
  let task = known();
  if (!task) {
    await loadAllTasks(ctx, uid, date);
    task = known();
  }
  if (!task) {
    throw new ProjoError('invalid_input', `Die Leistung ${taskId} ist für dich nicht buchbar oder unbekannt – erst projo_time_options (ggf. mit contract) aufrufen.`);
  }
  return task;
}

// ─── Schreiben ───────────────────────────────────────────────────────────────

export interface CreateInput {
  date: string;
  taskId: string;
  hours: number;
  description?: string;
  allowDuplicate?: boolean;
}

export interface WriteResult {
  status: 'created' | 'already_exists' | 'updated' | 'deleted';
  booking: Booking;
  day: DayView;
  task?: TaskOption;
}

function validateDescription(d: string | undefined): string {
  const text = (d ?? '').trim();
  if (text.length > 2000) throw new ProjoError('invalid_input', 'Die Beschreibung ist zu lang (max. 2000 Zeichen).');
  return text;
}

export async function createBooking(sessions: ProjoSessionManager, email: string, input: CreateInput): Promise<WriteResult> {
  assertIsoDate(input.date);
  assertBookableHours(input.hours);
  const description = validateDescription(input.description);

  return sessions.withUser(email, async (ctx) => {
    const uid = await sessions.userId(ctx);
    const task = await resolveTask(ctx, uid, input.date, input.taskId);
    const before = (await readDay(ctx, uid, input.date)).view;

    // Doppelbuchungsschutz: Clients wiederholen Aufrufe bei Timeouts
    const duplicate = before.bookings.find(
      (b) => bookingMatchesTask(b, task) && Math.abs(b.hours - input.hours) < 1e-6 && (b.description ?? '') === description,
    );
    if (duplicate && !input.allowDuplicate) return { status: 'already_exists', booking: duplicate, day: before, task };

    const formPage = await ctx.http.getPage(`/app/bookings/new?date=${input.date}&user_id=${uid}`);
    const result = await submitForm(ctx.http, {
      page: formPage,
      selector: '#new_time_tracking_booking',
      overrides: {
        'time_tracking_booking[duration_in_hour_min_str]': formatDuration(input.hours),
        'time_tracking_booking[task_id]': input.taskId,
        'time_tracking_booking[description]': description,
      },
      submitter: 'commit',
    });
    if (!result.ok) {
      throw new ProjoError('validation_failed', `projo hat die Buchung abgelehnt: ${result.errors.join('; ')}`, { errors: result.errors });
    }

    // Ergebnis bestätigen: Antwort enthält die neu gerenderte Tagesansicht, sonst nachlesen
    const beforeIds = new Set(before.bookings.map((b) => b.id));
    let after: DayView | undefined;
    try {
      after = parseDayView(cheerio.load(result.html), input.date);
    } catch {
      after = undefined;
    }
    let created = after?.bookings.filter((b) => b.id && !beforeIds.has(b.id)) ?? [];
    if (!after || created.length !== 1) {
      after = (await readDay(ctx, uid, input.date)).view;
      created = after.bookings.filter((b) => b.id && !beforeIds.has(b.id));
    }
    if (created.length !== 1) {
      throw new ProjoError('drift_detected', `Nach dem Buchen wurden ${created.length} neue Buchungen gefunden statt einer – bitte in projo prüfen.`, {
        newBookings: created,
      });
    }
    const booking = created[0]!;
    if (Math.abs(booking.hours - input.hours) > 1e-6 || !bookingMatchesTask(booking, task)) {
      throw new ProjoError('drift_detected', 'Die Buchung wurde angelegt, weicht aber von der Eingabe ab – bitte in projo prüfen.', { booking, expected: { hours: input.hours, task: task.label } });
    }
    return { status: 'created', booking, day: after, task };
  });
}

export interface UpdateInput {
  date: string;
  bookingId: string;
  hours?: number;
  description?: string;
  taskId?: string;
}

export async function updateBooking(sessions: ProjoSessionManager, email: string, input: UpdateInput): Promise<WriteResult & { before: Booking }> {
  assertIsoDate(input.date);
  if (input.hours === undefined && input.description === undefined && input.taskId === undefined) {
    throw new ProjoError('invalid_input', 'Mindestens eines von hours, description oder taskId angeben.');
  }
  if (input.hours !== undefined) assertBookableHours(input.hours);
  const description = input.description !== undefined ? validateDescription(input.description) : undefined;

  return sessions.withUser(email, async (ctx) => {
    const uid = await sessions.userId(ctx);
    const { view, csrf } = await readDay(ctx, uid, input.date);
    const before = view.bookings.find((b) => b.id === input.bookingId);
    if (!before) throw new ProjoError('not_found', `Buchung ${input.bookingId} am ${input.date} nicht gefunden.`);
    if (before.locked && (input.hours !== undefined || input.taskId !== undefined)) {
      throw new ProjoError('validation_failed', 'Die Zeiten dieses Tages sind in projo gesperrt – nur die Beschreibung kann noch geändert werden.');
    }
    if (!csrf) throw new ProjoError('drift_detected', 'CSRF-Token der Tagesansicht nicht gefunden.');
    const task = input.taskId ? await resolveTask(ctx, uid, input.date, input.taskId) : undefined;
    const bookingPath = `/app/bookings/${input.bookingId}?date=${input.date}&user_id=${uid}`;

    // best_in_place: PUT mit _method=put, Antwort 204 (auch bei ungültigen Werten → danach prüfen)
    const bip = async (attribute: string, value: string) => {
      const res = await ctx.http.send('PUT', bookingPath, {
        form: [['_method', 'put'], [`time_tracking_booking[${attribute}]`, value], ['authenticity_token', csrf]],
        xhr: true,
        accept: 'application/json',
        csrfToken: csrf,
      });
      if (res.status >= 400) throw new ProjoError('validation_failed', `projo hat die Änderung (${attribute}) abgelehnt: HTTP ${res.status}`);
    };
    if (input.hours !== undefined) await bip('duration_in_hour_min_str', formatDuration(input.hours));
    if (description !== undefined) await bip('description', description);
    if (input.taskId) {
      const res = await ctx.http.send('PATCH', `/app/bookings/${input.bookingId}/update_task?date=${input.date}&task_id=${input.taskId}&user_id=${uid}`, { xhr: true, csrfToken: csrf });
      if (res.status >= 400) throw new ProjoError('validation_failed', `projo hat den Leistungswechsel abgelehnt: HTTP ${res.status}`);
    }

    const after = (await readDay(ctx, uid, input.date)).view;
    const booking = after.bookings.find((b) => b.id === input.bookingId);
    if (!booking) throw new ProjoError('drift_detected', 'Die Buchung ist nach der Änderung nicht mehr auffindbar – bitte in projo prüfen.');
    const mismatches: string[] = [];
    if (input.hours !== undefined && Math.abs(booking.hours - input.hours) > 1e-6) mismatches.push(`Dauer ${booking.hours} statt ${input.hours}`);
    if (description !== undefined && (booking.description ?? '') !== description) mismatches.push('Beschreibung');
    if (task && !bookingMatchesTask(booking, task)) mismatches.push(`Leistung „${booking.label}“`);
    if (mismatches.length > 0) {
      throw new ProjoError('validation_failed', `projo hat die Änderung nicht vollständig übernommen: ${mismatches.join(', ')}.`, { booking });
    }
    return { status: 'updated', booking, before, day: after, ...(task ? { task } : {}) };
  });
}

export async function deleteBooking(sessions: ProjoSessionManager, email: string, input: { date: string; bookingId: string }): Promise<WriteResult> {
  assertIsoDate(input.date);
  return sessions.withUser(email, async (ctx) => {
    const uid = await sessions.userId(ctx);
    const { view, csrf } = await readDay(ctx, uid, input.date);
    const booking = view.bookings.find((b) => b.id === input.bookingId);
    if (!booking) throw new ProjoError('not_found', `Buchung ${input.bookingId} am ${input.date} nicht gefunden (evtl. schon gelöscht).`);
    if (booking.locked) throw new ProjoError('validation_failed', 'Die Zeiten dieses Tages sind in projo gesperrt – Löschen ist nicht möglich.');
    if (!csrf) throw new ProjoError('drift_detected', 'CSRF-Token der Tagesansicht nicht gefunden.');

    const res = await ctx.http.send('DELETE', `/app/bookings/${input.bookingId}?date=${input.date}&user_id=${uid}`, { xhr: true, csrfToken: csrf });
    if (res.status >= 400) throw new ProjoError('validation_failed', `projo hat das Löschen abgelehnt: HTTP ${res.status}`);

    const after = (await readDay(ctx, uid, input.date)).view;
    if (after.bookings.some((b) => b.id === input.bookingId)) {
      throw new ProjoError('drift_detected', 'Die Buchung ist nach dem Löschen noch vorhanden – bitte in projo prüfen.');
    }
    return { status: 'deleted', booking, day: after };
  });
}
