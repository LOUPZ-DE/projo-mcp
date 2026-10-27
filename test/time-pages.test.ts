import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { parseAllTasks, parseBookingForm, parseDayView, parseHoursAnalysis, parseMonthView, parseTaskOptions } from '../src/projo/pages/time.js';
import { bookingMatchesTask, labelMatches } from '../src/projo/recipes/time.js';
import { extractHtmlFromJs } from '../src/projo/util/dom.js';

const load = (name: string) => cheerio.load(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

describe('Tagesansicht', () => {
  it('liest Buchungen mit ID, Dauer, Vertrag, Leistung, Beschreibung', () => {
    const day = parseDayView(load('day.html'), '2026-03-10');
    expect(day.totalHours).toBe(8);
    expect(day.bookings).toEqual([
      { id: '900000001', hours: 2.5, label: '1000-Projekt-01 - Planung - Leistungsphase 2', contract: '1000-Projekt-01', task: 'Planung - Leistungsphase 2', description: 'Abstimmung mit Fachplanern' },
      { id: '900000002', hours: 5.5, label: '2000-Intern-08 - IT-Support', contract: '2000-Intern-08', task: 'IT-Support' },
    ]);
  });

  it('liest die neu gerenderte Tagesansicht aus der JS-Antwort nach dem Buchen', () => {
    const js = readFileSync(new URL('./fixtures/booking-created.js', import.meta.url), 'utf8');
    const day = parseDayView(cheerio.load(extractHtmlFromJs(js)), '2026-03-10');
    expect(day.bookings[0]).toMatchObject({ id: '900000003', hours: 1.25, task: 'IT-Support' });
  });

  it('meldet Drift bei fremder Seite', () => {
    expect(() => parseDayView(cheerio.load('<html><body><h1>Wartung</h1></body></html>'), '2026-03-10')).toThrowError(/unerwartetes Format/);
  });
});

describe('Monatsansicht', () => {
  const month = parseMonthView(load('month.html'), 2026);

  it('liest Soll/Ist/AZ-Konto-Karten inkl. dreistelliger Stunden', () => {
    expect(month.title).toBe('März 2026');
    expect(month.summary).toEqual([
      { label: 'Sollstunden (bis heute Abend)', hours: 152, detail: { label: 'Sollstunden (ab morgen)', hours: 24 } },
      { label: 'Gebuchte Stunden', hours: 132 },
      { label: 'Abwesenheiten', hours: 24 },
      { label: 'Differenz', hours: 4 },
      { label: 'AZ-Konto', hours: -46.88, detail: { label: 'am 01.03.2026 morgens', hours: -50.88 } },
    ]);
  });

  it('liest Buchungen je Tag (voller Name aus title, gekürzte Anzeige bleibt label)', () => {
    expect(month.days).toHaveLength(1);
    const d = month.days[0]!;
    expect(d.date).toBe('2026-03-02');
    expect(d.totalHours).toBe(16.5);
    expect(d.balance).toBe('+08:30 h');
    expect(d.bookings[1]).toEqual({
      hours: 10,
      label: '1000-Projekt-01 - Planung - Leistu ... aner Haustechnik',
      contract: '1000-Projekt-01',
      task: 'Planung - Leistungsphase 2 - Abstimmung Fachplaner Haustechnik',
      description: 'Termin vor Ort',
    });
  });
});

describe('Buchungsformular & Leistungen', () => {
  it('liest Verträge (inkl. ID des aktiven Vertrags aus „alle Leistungen“) und Leistungen', () => {
    const f = parseBookingForm(load('booking-new.html'));
    expect(f.activeContract).toBe('2000-Intern-08');
    expect(f.activeTreatyId).toBe('700002');
    expect(f.contracts).toEqual([
      { code: '1000-Projekt-01', title: 'Neubau Musterschule', treatyId: '700001', active: false },
      { code: '2000-Intern-08', title: 'Interne Leistungen', treatyId: '700002', active: true },
    ]);
    expect(f.tasks).toEqual([
      { taskId: '6000001', name: 'Hardware', leafId: '5000001' },
      { taskId: '6000002', name: 'IT-Support', leafId: '5000002' },
      { taskId: '6000003', name: 'Eigenentwicklungen - Werkzeug A', leafId: '5000003' },
    ]);
  });

  it('liest die Leistungsliste aus der Antwort des Vertragsfilters (JS)', () => {
    const js = `$("#filtered_tasks_as_input").html("<form id=\\"new_time_tracking_booking\\"><select name=\\"time_tracking_booking[task_id]\\"><option value=\\"\\"><\\/option><option data-time-tracking-leaf-url=\\"/time_tracking/leaves/5100001\\" value=\\"7100001\\">Leistungsstufe 2 - Kostenmanagement - Kostensteuerung - Standort Nord<\\/option><\\/select><\\/form>");`;
    expect(parseTaskOptions(cheerio.load(extractHtmlFromJs(js)))).toEqual([
      { taskId: '7100001', name: 'Leistungsstufe 2 - Kostenmanagement - Kostensteuerung - Standort Nord', leafId: '5100001' },
    ]);
  });

  it('liest die Gesamtliste aus edit_task', () => {
    const $ = cheerio.load(`<select class="select2 js-go_to_url">
      <option data-url="https://my.projo.berlin/app/bookings/1/update_task?date=2026-03-10&amp;task_id=7100001&amp;user_id=1001" data-remote="true" data-method="PATCH" value="7100001">1000-Projekt-01 - Leistungsstufe 2 - Kostenm ... Standort Nord</option>
    </select>`);
    expect(parseAllTasks($)).toEqual([{ taskId: '7100001', label: '1000-Projekt-01 - Leistungsstufe 2 - Kostenm ... Standort Nord', contract: '1000-Projekt-01' }]);
  });

  it('gleicht gekürzte Namen tolerant ab', () => {
    expect(labelMatches('Leistungsstufe 2 - Kostenmanagement - Standort Nord', 'Leistungsstufe 2 - Kostenm ... Standort Nord')).toBe(true);
    expect(labelMatches('Leistungsstufe 2 - Kostenmanagement - Standort Süd', 'Leistungsstufe 2 - Kostenm ... Standort Nord')).toBe(false);
    const task = { taskId: '1', contract: '1000-Projekt-01', name: 'Planung - Leistungsphase 2', label: '1000-Projekt-01 - Planung - Leistungsphase 2', complete: true };
    expect(bookingMatchesTask({ hours: 1, label: '1000-Projekt-01 - Planung - Leistungsphase 2', task: 'Planung - Leistungsphase 2' }, task)).toBe(true);
    expect(bookingMatchesTask({ hours: 1, label: '2000-Intern-08 - IT-Support', task: 'IT-Support' }, task)).toBe(false);
  });
});

describe('Stunden pro Projekt', () => {
  it('liest Projekte, Abwesenheiten und Summen', () => {
    expect(parseHoursAnalysis(load('analysis.html'))).toEqual({
      projects: [
        { project: '1000-Projekt', title: 'Neubau Musterschule', hours: 110, percent: 83.33 },
        { project: '2000-Intern', title: 'Interne Leistungen', hours: 22, percent: 16.67 },
      ],
      absences: [{ type: 'Urlaub', hours: 24 }],
      totals: { Projektstunden: 132, Abwesenheiten: 24, 'Summe Ist-Stunden gesamt': 156, Sollstunden: 152 },
    });
  });
});
