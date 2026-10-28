import { asArray, asNum, asObject, asStr, type ExtractSpec } from '../../harness/fallback.js';
import { roundHours } from '../util/de.js';
import type { Booking, DayView, HoursAnalysis, MonthView } from './time.js';

/**
 * KI-Ausweich-Extraktion für die lesenden Zeit-Ansichten – gleiche Ergebnisformate wie die festen Parser.
 * Schemata im strict-Stil (alle Felder required, optionale Werte als null).
 */

const nullableString = { type: ['string', 'null'] };
const nullableNumber = { type: ['number', 'null'] };

const bookingSchema = (withId: boolean) => ({
  type: 'object',
  additionalProperties: false,
  required: [...(withId ? ['id'] : []), 'hours', 'label', 'task', 'description'],
  properties: {
    ...(withId ? { id: nullableString } : {}),
    hours: { type: 'number' },
    label: { type: 'string' },
    task: nullableString,
    description: nullableString,
  },
});

function toBooking(raw: unknown): Booking | undefined {
  const b = asObject(raw, 'Buchung');
  const hours = asNum(b.hours);
  const label = asStr(b.label);
  if (hours === undefined || !label) return undefined;
  const i = label.indexOf(' - ');
  const id = asStr(b.id)?.replace(/^booking-/, '');
  const task = asStr(b.task);
  const description = asStr(b.description);
  return {
    ...(id ? { id } : {}),
    hours: roundHours(hours),
    label,
    ...(i > 0 ? { contract: label.slice(0, i) } : {}),
    ...(task ? { task } : {}),
    ...(description ? { description } : {}),
  };
}

export function daySpec(date: string): ExtractSpec<DayView> {
  return {
    key: 'time_day',
    task: `Extrahiere alle Zeitbuchungen der Tagesansicht vom ${date}: je Buchung die ID (aus id="booking-…" bzw. data-row-id), Dauer in Stunden, das Leistungs-Label "<Vertragscode> - <Leistung>" (label), den vollen Leistungsnamen (title-Attribut, task) und die Beschreibung/den Rechnungskommentar. Die Summenzeile ist keine Buchung.`,
    expectation: 'Zeilen tr[id^="booking-"] mit Dauer im best_in_place-Span (data-bip-attribute="duration_in_hour_min_str"), Label in span.label (title = Leistung), Beschreibung in data-bip-attribute="description"',
    schema: { type: 'object', additionalProperties: false, required: ['bookings'], properties: { bookings: { type: 'array', items: bookingSchema(true) } } },
    map: (raw) => {
      const bookings = asArray(asObject(raw, 'Ergebnis').bookings).map(toBooking).filter((b): b is Booking => !!b);
      return { date, bookings, totalHours: roundHours(bookings.reduce((s, b) => s + b.hours, 0)) };
    },
  };
}

export function monthSpec(month: string): ExtractSpec<MonthView> {
  return {
    key: 'time_month',
    task: `Extrahiere aus der Monatsansicht (${month}) die Kopfkarten (Bezeichnung, Stunden, ggf. Nebenwert mit Bezeichnung – z. B. Sollstunden, Gebuchte Stunden, Abwesenheiten, Differenz, AZ-Konto) und je Tag mit Buchungen das Datum (aus dem Link /app/dates/YYYY-MM-DD), die Buchungen (Dauer, Label, voller Leistungsname aus title, Beschreibung) und den AZ-Konto-Wert der Zeile.`,
    expectation: '#over_time .col (h3 = Wert, span.text-secondary = Bezeichnung, .small = Nebenwert); Zeilen tr.js-click-row[data-href] mit table.slim-table je Buchung',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'summary', 'days'],
      properties: {
        title: nullableString,
        summary: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['label', 'hours', 'detailLabel', 'detailHours'], properties: { label: { type: 'string' }, hours: { type: 'number' }, detailLabel: nullableString, detailHours: nullableNumber } },
        },
        days: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['date', 'bookings', 'balance'],
            properties: { date: { type: 'string' }, bookings: { type: 'array', items: bookingSchema(false) }, balance: nullableString },
          },
        },
      },
    },
    map: (raw) => {
      const o = asObject(raw, 'Ergebnis');
      const summary = asArray(o.summary)
        .map((s) => asObject(s, 'Kopfkarte'))
        .filter((s) => asStr(s.label) && asNum(s.hours) !== undefined)
        .map((s) => {
          const detailHours = asNum(s.detailHours);
          const detailLabel = asStr(s.detailLabel);
          return {
            label: asStr(s.label)!,
            hours: roundHours(asNum(s.hours)!),
            ...(detailLabel && detailHours !== undefined ? { detail: { label: detailLabel, hours: roundHours(detailHours) } } : {}),
          };
        });
      const days = asArray(o.days)
        .map((d) => asObject(d, 'Tag'))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(asStr(d.date) ?? ''))
        .map((d) => {
          const bookings = asArray(d.bookings).map(toBooking).filter((b): b is Booking => !!b);
          const balance = asStr(d.balance);
          return { date: asStr(d.date)!, bookings, totalHours: roundHours(bookings.reduce((s, b) => s + b.hours, 0)), ...(balance ? { balance } : {}) };
        });
      const title = asStr(o.title);
      return { ...(title ? { title } : {}), summary, days };
    },
  };
}

export function analysisSpec(): ExtractSpec<HoursAnalysis> {
  return {
    key: 'time_analysis',
    task: 'Extrahiere aus der Auswertung „Stunden pro Projekt“ je Projekt Kürzel, Titel, Stunden und Prozentanteil, je Abwesenheitsart die Stunden sowie alle Summenzeilen (z. B. Projektstunden, Abwesenheiten, Summe Ist-Stunden gesamt, Sollstunden) als Bezeichnung + Stunden.',
    expectation: 'Tabelle mit Kopf „geleistete Stunden pro Projekt“, Abschnitten per <th> (Abwesenheiten, Summe Ist-Stunden gesamt, Sollstunden)',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['projects', 'absences', 'totals'],
      properties: {
        projects: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['project', 'title', 'hours', 'percent'], properties: { project: { type: 'string' }, title: nullableString, hours: { type: 'number' }, percent: nullableNumber } },
        },
        absences: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['type', 'hours'], properties: { type: { type: 'string' }, hours: { type: 'number' } } } },
        totals: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'hours'], properties: { label: { type: 'string' }, hours: { type: 'number' } } } },
      },
    },
    map: (raw) => {
      const o = asObject(raw, 'Ergebnis');
      return {
        projects: asArray(o.projects)
          .map((p) => asObject(p, 'Projekt'))
          .filter((p) => asStr(p.project) && asNum(p.hours) !== undefined)
          .map((p) => ({
            project: asStr(p.project)!,
            ...(asStr(p.title) ? { title: asStr(p.title)! } : {}),
            hours: roundHours(asNum(p.hours)!),
            ...(asNum(p.percent) !== undefined ? { percent: asNum(p.percent)! } : {}),
          })),
        absences: asArray(o.absences)
          .map((a) => asObject(a, 'Abwesenheit'))
          .filter((a) => asStr(a.type) && asNum(a.hours) !== undefined)
          .map((a) => ({ type: asStr(a.type)!, hours: roundHours(asNum(a.hours)!) })),
        totals: Object.fromEntries(
          asArray(o.totals)
            .map((t) => asObject(t, 'Summe'))
            .filter((t) => asStr(t.label) && asNum(t.hours) !== undefined)
            .map((t) => [asStr(t.label)!, roundHours(asNum(t.hours)!)]),
        ),
      };
    },
  };
}
