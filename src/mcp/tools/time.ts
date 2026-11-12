import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isProjoError } from '../../projo/errors.js';
import type { Booking } from '../../projo/pages/time.js';
import {
  commonLevels,
  createBooking,
  createBookings,
  deleteBooking,
  hoursSummary,
  MAX_BATCH,
  timeEntries,
  timeOptions,
  updateBooking,
  type TaskOption,
  type WriteResult,
} from '../../projo/recipes/time.js';
import { audit, projoSessions } from '../../projo/runtime.js';
import { todayBerlin } from '../../projo/util/de.js';
import { respond } from '../respond.js';
import { CONNECT_CODES, connectHint, runTool, type Caller } from './common.js';

const isoDate = (what: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format YYYY-MM-DD').describe(what);
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const degradedHint = (pages?: string[]) =>
  `Achtung (degraded): ${pages?.length ? `Für ${pages.join(', ')} hat` : 'Hier hat'} der feste Parser die projo-Seite nicht erkannt; die Werte stammen aus der KI-Ausweich-Extraktion und können unvollständig sein – auch „keine Buchungen“ ist dann nicht sicher. Vor Entscheidungen in projo gegenprüfen.`;

/** Leistung fürs Tool-Ergebnis: Name, Gliederungsnummer und Pfad (ohne gemeinsame Ebenen) – ohne interne Felder */
const taskView = (t: TaskOption, withContract: boolean, skipLevels: number) => {
  const path = t.path?.slice(skipLevels).join(' › ');
  return {
    taskId: t.taskId,
    ...(withContract && t.contract ? { contract: t.contract } : {}),
    ...(t.number ? { number: t.number } : {}),
    name: t.leafName ?? t.name,
    ...(path ? { path } : {}),
    ...(t.status && t.status !== 'laufend' ? { status: t.status } : {}),
    ...(t.complete ? {} : { truncated: true }),
  };
};

/** gebuchte Leistung kompakt: Name aus der Tagesansicht (dort vollständig), sonst aus der Auswahl */
const bookedTask = (t: TaskOption, b: Booking) => ({ taskId: t.taskId, name: b.task ?? t.name });

/** Schreibaktion protokollieren (ohne Beschreibungstexte) und Fehler weiterreichen. */
async function audited<T extends WriteResult>(caller: Caller, action: string, details: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  try {
    const result = await fn();
    audit.write({ user: caller.email, action, result: 'ok', details: { ...details, status: result.status, bookingId: result.booking.id } });
    return result;
  } catch (err) {
    audit.write({ user: caller.email, action, result: 'error', details, error: isProjoError(err) ? `${err.code}: ${err.message}` : 'error' });
    throw err;
  }
}

const dayDigest = (r: WriteResult) => ({ date: r.day.date, totalHours: r.day.totalHours, bookings: r.day.bookings.length });

export function registerTimeTools(server: McpServer): void {
  server.registerTool(
    'projo_time_entries',
    {
      title: 'projo: Zeitbuchungen lesen',
      description:
        'Liest die eigenen Zeitbuchungen eines Tages oder Zeitraums (max. 92 Tage): Dauer, Vertrag, Leistung, Beschreibung. ' +
        'Bis 10 Tage tageweise inkl. Buchungs-IDs (nötig für Ändern/Löschen), darüber aus der Monatsansicht inkl. Soll/Ist und AZ-Konto, aber ohne IDs.',
      inputSchema: {
        from: isoDate('Startdatum YYYY-MM-DD'),
        to: isoDate('Enddatum YYYY-MM-DD (Standard: from)').optional(),
      },
      annotations: READ,
    },
    async ({ from, to }, extra) =>
      runTool('projo_time_entries', extra, async (caller) => {
        const r = await timeEntries(projoSessions, caller.email, from, to ?? from);
        const next: string[] = [];
        if (r.degraded) next.push(degradedHint(r.degradedPages));
        if (r.source === 'monatsansicht') next.push('Für Buchungs-IDs (Ändern/Löschen) projo_time_entries mit einem Zeitraum bis 10 Tage aufrufen.');
        if (r.days.length === 0) next.push(`projo_time_options with {"query": "<Stichwort>"} – passende Leistung finden, dann projo_time_entry_create`);
        return respond({ ...r }, next.length ? next : undefined);
      }),
  );

  server.registerTool(
    'projo_time_summary',
    {
      title: 'projo: Stunden pro Projekt',
      description: 'Auswertung „Stunden pro Projekt“ für einen Zeitraum: geleistete Stunden und Anteil je Projekt, Abwesenheiten, Ist- und Sollstunden.',
      inputSchema: {
        from: isoDate('Startdatum YYYY-MM-DD'),
        to: isoDate('Enddatum YYYY-MM-DD'),
      },
      annotations: READ,
    },
    async ({ from, to }, extra) =>
      runTool('projo_time_summary', extra, async (caller) => {
        const r = await hoursSummary(projoSessions, caller.email, from, to);
        return respond({ ...r }, r.degraded ? [degradedHint()] : undefined);
      }),
  );

  server.registerTool(
    'projo_time_options',
    {
      title: 'projo: buchbare Leistungen',
      description:
        'Findet die Leistungen, auf die die Person Zeit buchen kann – Verträge und Leistungen unterscheiden sich je Person und Büro. ' +
        'Ohne Parameter: Verträge + Leistungen des in projo aktiven Vertrags. Mit query: Suche über alle Verträge in der vollständigen ' +
        'Leistungsgliederung – Vertrag, Gliederungsnummer, übergeordnete Ebenen (z. B. Leistungsstufe, Tätigkeit) und Leistungsname; alle Wörter ' +
        'müssen vorkommen, Groß-/Kleinschreibung egal. Mit contract (Vertragscode): alle Leistungen dieses Vertrags. Jede Leistung kommt mit taskId, ' +
        'number und path – gleichnamige Leistungen (z. B. derselbe Standort unter verschiedenen Tätigkeiten) unterscheiden sich darüber; ' +
        'obere Ebenen, die alle Treffer teilen, stehen einmal in commonPath, path enthält dann nur die Ebenen darunter. ' +
        'Für die taskIds anderer Verträge schaltet das Tool kurz den Vertragsfilter in projo um und stellt ihn danach wieder her.',
      inputSchema: {
        query: z.string().max(200).optional().describe('Suchwörter, z. B. "Terminsteuerung Garching", "IT-Support" oder eine Gliederungsnummer wie "2.1.2.1"'),
        contract: z.string().max(100).optional().describe('Vertragscode wie in projo, z. B. "1000-Projekt-01"'),
        date: isoDate('Buchungsdatum YYYY-MM-DD (Standard: heute)').optional(),
        limit: z.number().int().min(1).max(200).optional().describe('max. Anzahl Treffer (Standard 40)'),
      },
      annotations: READ,
    },
    async (args, extra) =>
      runTool('projo_time_options', extra, async (caller) => {
        const r = await timeOptions(projoSessions, caller.email, args);
        const date = args.date ?? todayBerlin();
        const next: string[] = [];
        if (r.tasks.some((t) => !t.complete)) {
          next.push('Einige Namen sind von projo gekürzt („ ... “) – für volle Namen projo_time_options with {"contract": "<Vertragscode>"} aufrufen.');
        }
        if (r.matches === 1) {
          next.push(`projo_time_entry_create with {"date": "${date}", "taskId": "${r.tasks[0]!.taskId}", "hours": <Stunden>, "description": "<Text>"}`);
        } else if (r.matches > 1) {
          const names = r.tasks.map((t) => (t.leafName ?? t.name).toLowerCase());
          if (new Set(names).size < names.length) {
            next.push('Gleichnamige Leistungen unter verschiedenen übergeordneten Ebenen – vor dem Buchen nachfragen, welche gemeint ist (path bzw. number unterscheiden sie).');
          }
          next.push(`projo_time_entry_create with {"date": "${date}", "taskId": "<taskId der gewählten Leistung>", "hours": <Stunden>, "description": "<Text>"}`);
        } else if (args.query) {
          next.push(
            args.contract
              ? 'Keine Treffer in diesem Vertrag – andere Wörter versuchen oder ohne query alle Leistungen des Vertrags ansehen.'
              : 'Keine Treffer – andere Wörter versuchen (auch aus Tätigkeit, Standort oder Gliederungsnummer) oder mit contract einen Vertrag ansehen.',
          );
        }
        if (r.matches > r.tasks.length) next.push(`${r.matches} Treffer, ${r.tasks.length} gezeigt – mit Wörtern aus dem Pfad oder der Nummer eingrenzen oder limit erhöhen.`);
        const searching = Boolean(args.query?.trim()) && !args.contract;
        const common = commonLevels(r.tasks);
        return respond(
          {
            date: r.date,
            ...(r.contract ? { contract: r.contract } : {}),
            ...(r.contracts ? { contracts: r.contracts } : {}),
            matches: r.matches,
            ...(common.length ? { commonPath: common.join(' › ') } : {}),
            tasks: r.tasks.map((t) => taskView(t, searching, common.length)),
          },
          next,
        );
      }),
  );

  server.registerTool(
    'projo_time_entry_create',
    {
      title: 'projo: Arbeitszeit buchen',
      description:
        'Bucht Arbeitszeit auf eine Leistung (taskId aus projo_time_options). Dauer in Stunden im 15-Minuten-Raster (z. B. 1.25). ' +
        'Schutz vor Doppelbuchungen: Existiert am Tag schon eine identische Buchung (Leistung, Dauer, Beschreibung), wird keine zweite angelegt ' +
        '(allowDuplicate: true erzwingt sie). Das Ergebnis wird in projo nachgelesen und bestätigt.',
      inputSchema: {
        date: isoDate('Datum YYYY-MM-DD'),
        taskId: z.string().regex(/^\d+$/, 'numerische taskId').describe('Leistung aus projo_time_options'),
        hours: z.number().positive().max(24).describe('Dauer in Stunden, 15-Minuten-Raster, z. B. 2.5'),
        description: z.string().max(2000).optional().describe('Rechnungskommentar / Beschreibung der Tätigkeit'),
        allowDuplicate: z.boolean().optional().describe('identische Buchung trotzdem anlegen'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args, extra) =>
      runTool('projo_time_entry_create', extra, async (caller) => {
        const r = await audited(caller, 'time_entry.create', { date: args.date, taskId: args.taskId, hours: args.hours, hasDescription: Boolean(args.description) }, () =>
          createBooking(projoSessions, caller.email, args),
        );
        return respond(
          { status: r.status, booking: r.booking, ...(r.task ? { task: bookedTask(r.task, r.booking) } : {}), day: dayDigest(r) },
          r.status === 'already_exists'
            ? ['Eine identische Buchung existiert bereits – nichts angelegt. Nur bei Absicht mit allowDuplicate: true wiederholen.']
            : [`projo_time_entry_update with {"date": "${args.date}", "bookingId": "${r.booking.id}", "hours": <neu>} – falls korrigiert werden muss`],
        );
      }),
  );

  server.registerTool(
    'projo_time_entry_create_batch',
    {
      title: 'projo: mehrere Arbeitszeiten buchen',
      description:
        `Bucht mehrere Arbeitszeiten in einem Aufruf (bis ${MAX_BATCH}, z. B. eine ganze Woche) – je Eintrag wie projo_time_entry_create: ` +
        'taskId aus projo_time_options, Dauer im 15-Minuten-Raster, optional Beschreibung. Vorab werden alle Einträge geprüft; ist einer ungültig, ' +
        'wird nichts gebucht. Dann wird der Reihe nach gebucht und jede Buchung in projo bestätigt. Bei einem Fehler stoppt der Aufruf; das Ergebnis ' +
        'zeigt je Eintrag den Stand (created, already_exists, failed, skipped). Doppelbuchungsschutz wie beim Einzelaufruf.',
      inputSchema: {
        entries: z
          .array(
            z.object({
              date: isoDate('Datum YYYY-MM-DD'),
              taskId: z.string().regex(/^\d+$/, 'numerische taskId').describe('Leistung aus projo_time_options'),
              hours: z.number().positive().max(24).describe('Dauer in Stunden, 15-Minuten-Raster, z. B. 2.5'),
              description: z.string().max(2000).optional().describe('Rechnungskommentar / Beschreibung der Tätigkeit'),
              allowDuplicate: z.boolean().optional().describe('identische Buchung trotzdem anlegen'),
            }),
          )
          .min(1)
          .max(MAX_BATCH)
          .describe('Buchungen in der gewünschten Reihenfolge'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ entries }, extra) =>
      runTool('projo_time_entry_create_batch', extra, async (caller) => {
        const r = await createBookings(projoSessions, caller.email, entries).catch((err: unknown) => {
          audit.write({ user: caller.email, action: 'time_entry.create_batch', result: 'error', details: { entries: entries.length }, error: isProjoError(err) ? `${err.code}: ${err.message}` : 'error' });
          throw err;
        });
        // je Eintrag eine Audit-Zeile wie beim Einzelaufruf (ohne Beschreibungstexte)
        for (const e of r.entries) {
          if (e.status === 'skipped') continue;
          const input = entries[e.index - 1]!;
          audit.write({
            user: caller.email,
            action: 'time_entry.create',
            result: e.status === 'failed' ? 'error' : 'ok',
            details: { date: e.date, taskId: e.taskId, hours: input.hours, hasDescription: Boolean(input.description), batch: true, status: e.status, bookingId: e.booking?.id },
            ...(e.error ? { error: `${e.error.code}: ${e.error.message}` } : {}),
          });
        }

        const count = (status: string) => r.entries.filter((e) => e.status === status).length;
        const next: string[] = [];
        const failed = r.entries.find((e) => e.status === 'failed');
        if (failed?.error) {
          if (CONNECT_CODES.includes(failed.error.code)) next.push(connectHint());
          next.push(
            `Eintrag ${failed.index} wurde nicht gebucht (${failed.error.message}) – Ursache klären, dann die Einträge ab Eintrag ${failed.index} erneut übergeben; bereits Gebuchtes wird als already_exists erkannt.`,
          );
        }
        if (count('already_exists') > 0) {
          next.push(`${count('already_exists')} Einträge gab es schon identisch – nicht doppelt angelegt (allowDuplicate: true im Eintrag erzwingt es).`);
        }
        if (count('created') > 0) next.push('Korrekturen einzeln mit projo_time_entry_update (bookingId aus entries[].booking.id).');
        return respond(
          {
            summary: { created: count('created'), already_exists: count('already_exists'), failed: count('failed'), skipped: count('skipped') },
            entries: r.entries.map((e) => ({
              index: e.index,
              date: e.date,
              status: e.status,
              ...(e.booking
                ? { booking: { id: e.booking.id, hours: e.booking.hours, label: e.booking.label, ...(e.booking.description ? { description: e.booking.description } : {}) } }
                : { taskId: e.taskId }),
              ...(e.error ? { error: e.error } : {}),
            })),
            days: r.days.map((d) => ({ date: d.date, totalHours: d.totalHours, bookings: d.bookings.length })),
          },
          next,
        );
      }),
  );

  server.registerTool(
    'projo_time_entry_update',
    {
      title: 'projo: Zeitbuchung ändern',
      description:
        'Ändert Dauer, Beschreibung und/oder Leistung einer Buchung (bookingId aus projo_time_entries). ' +
        'Bei gesperrten Zeiten ist nur noch die Beschreibung änderbar. Das Ergebnis wird nachgelesen und bestätigt.',
      inputSchema: {
        date: isoDate('Datum der Buchung YYYY-MM-DD'),
        bookingId: z.string().regex(/^\d+$/).describe('Buchungs-ID aus projo_time_entries'),
        hours: z.number().positive().max(24).optional().describe('neue Dauer in Stunden (15-Minuten-Raster)'),
        description: z.string().max(2000).optional().describe('neue Beschreibung (leer = entfernen)'),
        taskId: z.string().regex(/^\d+$/).optional().describe('neue Leistung aus projo_time_options'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args, extra) =>
      runTool('projo_time_entry_update', extra, async (caller) => {
        const r = await audited(
          caller,
          'time_entry.update',
          { date: args.date, bookingId: args.bookingId, hours: args.hours, taskId: args.taskId, descriptionChanged: args.description !== undefined },
          () => updateBooking(projoSessions, caller.email, args),
        );
        return respond({ status: r.status, before: r.before, booking: r.booking, day: dayDigest(r) });
      }),
  );

  server.registerTool(
    'projo_time_entry_delete',
    {
      title: 'projo: Zeitbuchung löschen',
      description: 'Löscht genau eine Buchung (bookingId aus projo_time_entries) und bestätigt das Ergebnis. Gesperrte Zeiten können nicht gelöscht werden.',
      inputSchema: {
        date: isoDate('Datum der Buchung YYYY-MM-DD'),
        bookingId: z.string().regex(/^\d+$/).describe('Buchungs-ID aus projo_time_entries'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args, extra) =>
      runTool('projo_time_entry_delete', extra, async (caller) => {
        const r = await audited(caller, 'time_entry.delete', { date: args.date, bookingId: args.bookingId }, () => deleteBooking(projoSessions, caller.email, args));
        return respond({ status: r.status, deleted: r.booking, day: dayDigest(r) });
      }),
  );
}
