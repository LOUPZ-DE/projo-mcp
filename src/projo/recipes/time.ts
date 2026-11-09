import * as cheerio from 'cheerio';
import { isProjoError, ProjoError } from '../errors.js';
import { submitForm } from '../form.js';
import { csrfFromPage } from '../http.js';
import { extractHtmlFromJs } from '../util/dom.js';
import { recordDrift } from '../../harness/drift.js';
import { parseWithFallback } from '../../harness/fallback.js';
import { analysisSpec, daySpec, monthSpec } from '../pages/time-fallback.js';
import { log } from '../../util/log.js';
import {
  parseAllTasks,
  parseBookingForm,
  parseDayView,
  parseHoursAnalysis,
  parseMonthView,
  parseTaskOptions,
  parseTaskTree,
  type Booking,
  type BookingFormInfo,
  type ContractInfo,
  type DayView,
  type HoursAnalysis,
  type MonthView,
  type TaskTreeNode,
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
  /** Knoten im Leistungsbaum – verbindet den Select-Eintrag mit Nummer, Pfad und Status */
  leafId?: string;
  /** aus dem Leistungsbaum: Gliederungsnummer, z. B. "2.1.1.1.7" */
  number?: string;
  /** aus dem Leistungsbaum: übergeordnete Ebenen, z. B. ["Leistungsstufe 2", "Planungsmanagement", …] */
  path?: string[];
  /** aus dem Leistungsbaum: Name der Leistung selbst (letzte Ebene, z. B. ein Standort) */
  leafName?: string;
  /** aus dem Leistungsbaum: Status, z. B. "laufend" oder "nicht abrechenbar" */
  status?: string;
}

/** Baumzeile einer buchbaren Leistung, aufbereitet für Suche und Anzeige */
interface TreeEntry {
  order: number;
  number?: string;
  name: string;
  path: string[];
  status?: string;
}

interface UserOptionsCache {
  form?: { at: number; info: BookingFormInfo; csrf?: string };
  /** Leistungen je Vertrag (treatyId → Liste mit vollen Namen) */
  contracts: Map<string, { at: number; tasks: TaskOption[] }>;
  /** Leistungsbaum je Vertrag (treatyId → leafId → Eintrag); undefined = nicht lesbar */
  trees: Map<string, { at: number; index?: Map<string, TreeEntry> }>;
  /** Gesamtliste aller buchbaren Leistungen */
  all?: { at: number; tasks: TaskOption[]; source: 'gesamtliste' | 'je-vertrag' };
}
const caches = new Map<string, UserOptionsCache>();

const cacheOf = (email: string): UserOptionsCache => {
  let c = caches.get(email);
  if (!c) {
    c = { contracts: new Map(), trees: new Map() };
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

const toOption = (raw: { taskId: string; name: string; leafId?: string }, contract: string | undefined, contractTitle?: string): TaskOption => ({
  taskId: raw.taskId,
  ...(contract ? { contract } : {}),
  ...(contractTitle ? { contractTitle } : {}),
  name: raw.name,
  label: contract ? `${contract} - ${raw.name}` : raw.name,
  complete: !raw.name.includes(' ... '),
  ...(raw.leafId ? { leafId: raw.leafId } : {}),
});

/** Baumzeilen → buchbare Leistungen (leafId) mit Pfad aus den übergeordneten Ebenen */
function indexTree(nodes: TaskTreeNode[]): Map<string, TreeEntry> {
  const index = new Map<string, TreeEntry>();
  const stack: string[] = [];
  nodes.forEach((n, order) => {
    stack.length = Math.min(stack.length, n.level - 1);
    if (n.leafId) {
      index.set(n.leafId, { order, ...(n.number ? { number: n.number } : {}), name: n.name, path: stack.filter(Boolean), ...(n.status ? { status: n.status } : {}) });
    }
    stack[n.level - 1] = n.name;
  });
  return index;
}

/** Select-Einträge um Nummer, Pfad und Status aus dem Leistungsbaum ergänzen (Schlüssel: leafId). */
function withTree(tasks: TaskOption[], index: Map<string, TreeEntry> | undefined): TaskOption[] {
  if (!index) return tasks;
  const enriched = tasks.map((t) => {
    const e = t.leafId ? index.get(t.leafId) : undefined;
    return e ? { ...t, ...(e.number ? { number: e.number } : {}), path: e.path, leafName: e.name, ...(e.status ? { status: e.status } : {}) } : t;
  });
  // je Vertrag in der Reihenfolge des Baums (Gliederung), Einträge ohne Baumzeile ans Ende
  const contractRank = new Map<string | undefined, number>();
  for (const t of tasks) if (!contractRank.has(t.contract)) contractRank.set(t.contract, contractRank.size);
  const order = (t: TaskOption) => (t.leafId ? (index.get(t.leafId)?.order ?? Infinity) : Infinity);
  return enriched
    .map((t, i) => ({ t, i }))
    .sort((a, b) => contractRank.get(a.t.contract)! - contractRank.get(b.t.contract)! || order(a.t) - order(b.t) || a.i - b.i)
    .map((x) => x.t);
}

// ─── Lesen ───────────────────────────────────────────────────────────────────

export interface TimeEntriesResult {
  from: string;
  to: string;
  source: 'tagesansicht' | 'monatsansicht';
  days: { date: string; bookings: Booking[]; totalHours: number; balance?: string }[];
  totalHours: number;
  months?: { month: string; title?: string; summary: MonthView['summary'] }[];
  /** true = mindestens eine Seite per KI-Ausweich-Extraktion gelesen (projo-Oberfläche nicht erkannt) */
  degraded?: boolean;
  /** Tage (Tagesansicht) bzw. Monate (Monatsansicht), die per KI-Ausweich-Extraktion gelesen wurden */
  degradedPages?: string[];
}

export async function timeEntries(sessions: ProjoSessionManager, email: string, from: string, to: string): Promise<TimeEntriesResult> {
  validateRange(from, to);
  return sessions.withUser(email, async (ctx) => {
    const uid = await sessions.userId(ctx);
    const degradedPages: string[] = [];
    const flags = () => (degradedPages.length > 0 ? { degraded: true, degradedPages } : {});
    if (daysInclusive(from, to) <= DAY_MODE_MAX_DAYS) {
      const days: TimeEntriesResult['days'] = [];
      for (let d = from; d <= to; d = addDays(d, 1)) {
        const page = await ctx.http.getPage(dayPath(uid, d));
        const r = await parseWithFallback(page.html, () => parseDayView(page.$, d), daySpec(d));
        if (r.degraded) degradedPages.push(d);
        if (r.value.bookings.length > 0) days.push(r.value);
      }
      return { from, to, source: 'tagesansicht', days, totalHours: roundHours(days.reduce((s, d) => s + d.totalHours, 0)), ...flags() };
    }
    const days: TimeEntriesResult['days'] = [];
    const months: NonNullable<TimeEntriesResult['months']> = [];
    for (const m of monthsBetween(from, to)) {
      const page = await ctx.http.getPage(`/app/months?date=${m}&user_id=${uid}`);
      const r = await parseWithFallback(page.html, () => parseMonthView(page.$, Number(m.slice(0, 4))), monthSpec(m.slice(0, 7)));
      if (r.degraded) degradedPages.push(m.slice(0, 7));
      const mv = r.value;
      months.push({ month: m.slice(0, 7), ...(mv.title ? { title: mv.title } : {}), summary: mv.summary });
      days.push(...mv.days.filter((d) => d.date >= from && d.date <= to && d.bookings.length > 0));
    }
    return { from, to, source: 'monatsansicht', days, totalHours: roundHours(days.reduce((s, d) => s + d.totalHours, 0)), months, ...flags() };
  });
}

export async function hoursSummary(sessions: ProjoSessionManager, email: string, from: string, to: string): Promise<HoursAnalysis & { from: string; to: string; degraded?: boolean }> {
  assertIsoDate(from, 'from');
  assertIsoDate(to, 'to');
  if (to < from) throw new ProjoError('invalid_input', '„to“ liegt vor „from“.');
  return sessions.withUser(email, async (ctx) => {
    const uid = await sessions.userId(ctx);
    const page = await ctx.http.getPage(`/app/bookings_analysis?user_id=${uid}&date=${toGermanDate(from)}&end_date=${toGermanDate(to)}`);
    const r = await parseWithFallback(page.html, () => parseHoursAnalysis(page.$), analysisSpec());
    return { from, to, ...r.value, ...(r.degraded ? { degraded: true } : {}) };
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

/**
 * Leistungsbaum eines Vertrags („alle Leistungen“) – reiner GET, ändert nichts in projo. Liefert Nummer, Pfad und
 * Status je buchbarer Leistung (Schlüssel leafId); nicht lesbar → undefined, die Suche nutzt dann die Namen.
 */
async function loadTree(ctx: ProjoUserContext, uid: string, treatyId: string): Promise<Map<string, TreeEntry> | undefined> {
  const cache = cacheOf(ctx.record.mcpEmail);
  const hit = cache.trees.get(treatyId);
  if (hit && fresh(hit.at)) return hit.index;
  const page = await ctx.http.getPage(`/app/structure_bookings/new?treaty_id=${treatyId}&user_id=${uid}`, { xhr: true }).catch((err: unknown) => {
    if (isProjoError(err) && (err.code === 'projo_forbidden' || err.code === 'not_found')) return undefined;
    throw err;
  });
  let index: Map<string, TreeEntry> | undefined;
  if (page) {
    try {
      index = indexTree(parseTaskTree(page.$));
    } catch (err) {
      if (!isProjoError(err) || err.code !== 'drift_detected') throw err;
      recordDrift('time_tree', page.html, err.message);
      log('warn', 'projo: Leistungsbaum nicht lesbar – Suche nutzt die Namen', { user: ctx.record.mcpEmail, reason: err.message });
    }
  }
  cache.trees.set(treatyId, { at: Date.now(), ...(index ? { index } : {}) });
  return index;
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
  /** Überblick: alle Verträge der Person; Suche: nur Verträge mit Treffern (ohne Treffer: alle, zum Eingrenzen) */
  contracts?: { code: string; title?: string; active?: boolean; matches?: number }[];
  /** Vertrag, auf den sich `tasks` bezieht (contract-Abfrage bzw. aktiver Vertrag im Überblick) */
  contract?: { code: string; title?: string };
  source: 'vertrag' | 'leistungsbaum' | 'gesamtliste' | 'je-vertrag';
  tasks: TaskOption[];
  matches: number;
}

const contractRef = (c: ContractInfo) => ({ code: c.code, ...(c.title ? { title: c.title } : {}) });
const searchText = (parts: (string | undefined)[]) => normalize(parts.filter(Boolean).join(' '));
/** Suchtext einer Leistung: Vertrag, Gliederungsnummer, übergeordnete Ebenen und Name */
const taskText = (t: TaskOption) => searchText([t.contract, t.contractTitle, t.number, ...(t.path ?? []), t.leafName ?? t.name]);

/**
 * Suche über alle Verträge: zuerst in den Leistungsbäumen (nur lesend, volle Namen inkl. Pfad), die taskIds dann
 * nur für Verträge mit Treffern über den Vertragsfilter. Ganz ohne lesbaren Baum: Gesamtliste wie bisher.
 */
async function searchAllContracts(
  ctx: ProjoUserContext,
  uid: string,
  date: string,
  info: BookingFormInfo,
  hit: (text: string) => boolean,
): Promise<{ tasks: TaskOption[]; source: TimeOptionsResult['source'] }> {
  const merged = new Map<string, TreeEntry>();
  const load: ContractInfo[] = [];
  let trees = 0;
  for (const c of info.contracts) {
    if (!c.treatyId) continue;
    const index = await loadTree(ctx, uid, c.treatyId);
    if (index) {
      trees++;
      for (const [leafId, e] of index) merged.set(leafId, e);
    }
    // ohne lesbaren Baum: Leistungen des Vertrags laden und über die Namen suchen
    if (!index || [...index.values()].some((e) => hit(searchText([c.code, c.title, e.number, ...e.path, e.name])))) load.push(c);
  }
  if (trees > 0) return { tasks: withTree(await loadContractsTasks(ctx, uid, date, load), merged), source: 'leistungsbaum' };

  const all = await loadAllTasks(ctx, uid, date);
  // In gekürzten Namen der Gesamtliste fehlt der Mittelteil → ohne Treffer volle Listen aller Verträge laden
  if (all.tasks.some((t) => hit(taskText(t))) || all.tasks.every((t) => t.complete)) return all;
  const tasks = await loadContractsTasks(ctx, uid, date, info.contracts);
  const cache = cacheOf(ctx.record.mcpEmail);
  const byId = new Map((cache.all?.tasks ?? []).map((t) => [t.taskId, t]));
  for (const t of tasks) byId.set(t.taskId, t);
  cache.all = { at: Date.now(), tasks: [...byId.values()], source: 'je-vertrag' };
  return { tasks, source: 'je-vertrag' };
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
    const words = normalize(opts.query ?? '').split(/\s+/).filter(Boolean);
    const hit = (text: string) => words.every((w) => text.includes(w));
    const result = (tasks: TaskOption[], rest: Pick<TimeOptionsResult, 'contracts' | 'contract' | 'source'>): TimeOptionsResult => {
      const matches = tasks.filter((t) => hit(taskText(t)));
      return { date, ...rest, tasks: matches.slice(0, limit), matches: matches.length };
    };

    if (opts.contract) {
      const c = findContract(info, opts.contract);
      const tasks = await loadContractsTasks(ctx, uid, date, [c]);
      return result(withTree(tasks, c.treatyId ? await loadTree(ctx, uid, c.treatyId) : undefined), { contract: contractRef(c), source: 'vertrag' });
    }
    if (words.length === 0) {
      const active = info.contracts.find((c) => c.active);
      const tasks = info.tasks.map((t) => toOption(t, info.activeContract, active?.title));
      return result(withTree(tasks, info.activeTreatyId ? await loadTree(ctx, uid, info.activeTreatyId) : undefined), {
        contracts: info.contracts.map((c) => ({ ...contractRef(c), active: c.active })),
        ...(active ? { contract: contractRef(active) } : {}),
        source: 'vertrag',
      });
    }

    const found = await searchAllContracts(ctx, uid, date, info, hit);
    const r = result(found.tasks, { source: found.source });
    const perContract = new Map<string, number>();
    for (const t of found.tasks) if (t.contract && hit(taskText(t))) perContract.set(t.contract, (perContract.get(t.contract) ?? 0) + 1);
    // nur Verträge mit Treffern – ohne Treffer alle, damit gezielt ein Vertrag gewählt werden kann
    const contracts =
      r.matches > 0
        ? info.contracts.filter((c) => perContract.has(c.code)).map((c) => ({ ...contractRef(c), matches: perContract.get(c.code)! }))
        : info.contracts.map((c) => ({ ...contractRef(c), active: c.active }));
    return { ...r, contracts };
  });
}

/** Obere Ebenen, die alle Leistungen (eines Vertrags) teilen – im Tool-Ergebnis einmal statt in jedem Pfad. */
export function commonLevels(tasks: TaskOption[]): string[] {
  if (tasks.length < 2 || new Set(tasks.map((t) => t.contract)).size > 1 || tasks.some((t) => !t.path?.length)) return [];
  const first = tasks[0]!.path!;
  let n = 0;
  while (n < first.length && tasks.every((t) => t.path![n] === first[n])) n++;
  return first.slice(0, n);
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
