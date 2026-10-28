import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { isProjoError } from '../../projo/errors.js';
import { createBooking, deleteBooking, hoursSummary, timeEntries, timeOptions, updateBooking, type WriteResult } from '../../projo/recipes/time.js';
import { audit, projoSessions } from '../../projo/runtime.js';
import { todayBerlin } from '../../projo/util/de.js';
import { respond } from '../respond.js';
import { runTool, type Caller } from './common.js';

const isoDate = (what: string) => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format YYYY-MM-DD').describe(what);
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const DEGRADED_HINT =
  'Achtung: Die projo-Oberfläche hat sich geändert, die Werte wurden per KI-Ausweich-Extraktion gelesen (degraded: true) – vor Entscheidungen in projo gegenprüfen.';

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
        if (r.degraded) next.push(DEGRADED_HINT);
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
        return respond({ ...r }, r.degraded ? [DEGRADED_HINT] : undefined);
      }),
  );

  server.registerTool(
    'projo_time_options',
    {
      title: 'projo: buchbare Leistungen',
      description:
        'Findet die Leistungen, auf die die Person Zeit buchen kann – Verträge und Leistungen unterscheiden sich je Person und Büro. ' +
        'Ohne Parameter: Verträge + Leistungen des in projo aktiven Vertrags. Mit query: Suche über alle Verträge (Wörter, Groß-/Kleinschreibung egal). ' +
        'Mit contract (Vertragscode): alle Leistungen dieses Vertrags mit vollen Namen – dafür schaltet das Tool kurz den Vertragsfilter in projo um ' +
        'und stellt ihn danach wieder her. Liefert taskId für projo_time_entry_create.',
      inputSchema: {
        query: z.string().max(200).optional().describe('Suchwörter, z. B. "Leistungsphase 5 Garching" oder "IT-Support"'),
        contract: z.string().max(100).optional().describe('Vertragscode wie in projo, z. B. "1000-Projekt-01"'),
        date: isoDate('Buchungsdatum YYYY-MM-DD (Standard: heute)').optional(),
        limit: z.number().int().min(1).max(200).optional().describe('max. Anzahl Treffer (Standard 40)'),
      },
      annotations: READ,
    },
    async (args, extra) =>
      runTool('projo_time_options', extra, async (caller) => {
        const r = await timeOptions(projoSessions, caller.email, args);
        const next: string[] = [];
        if (r.tasks.some((t) => !t.complete)) {
          next.push('Einige Namen sind von projo gekürzt („ ... “) – für volle Namen projo_time_options with {"contract": "<Vertragscode>"} aufrufen.');
        }
        if (r.tasks.length > 0) {
          const t = r.tasks[0]!;
          next.push(`projo_time_entry_create with {"date": "${args.date ?? todayBerlin()}", "taskId": "${t.taskId}", "hours": <Stunden>, "description": "<Text>"}`);
        } else if (args.query && !args.contract) {
          next.push('Keine Treffer – andere Suchwörter versuchen oder mit contract gezielt einen Vertrag laden.');
        }
        if (r.matches > r.tasks.length) next.push(`${r.matches} Treffer, ${r.tasks.length} gezeigt – query präzisieren oder limit erhöhen.`);
        return respond({ ...r }, next);
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
          { status: r.status, booking: r.booking, ...(r.task ? { task: r.task } : {}), day: dayDigest(r) },
          r.status === 'already_exists'
            ? ['Eine identische Buchung existiert bereits – nichts angelegt. Nur bei Absicht mit allowDuplicate: true wiederholen.']
            : [`projo_time_entry_update with {"date": "${args.date}", "bookingId": "${r.booking.id}", "hours": <neu>} – falls korrigiert werden muss`],
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
