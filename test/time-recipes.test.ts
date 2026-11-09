import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { driftDir } from '../src/harness/drift.js';
import { commonLevels, createBooking, deleteBooking, timeEntries, timeOptions, updateBooking } from '../src/projo/recipes/time.js';
import { ProjoSessionManager } from '../src/projo/session.js';
import { Vault } from '../src/projo/vault.js';
import { startFakeProjo, type FakeProjo } from './fake-projo/server.js';

/**
 * Schreib-Abläufe der Zeiterfassung gegen den Fake-projo – inkl. der in echt gefundenen Fallstricke:
 * fehlende Server-Validierung, CSRF über das Meta-Token, Filter-Wiederherstellung, Doppelbuchungen.
 */

let fake: FakeProjo;
let mgr: ProjoSessionManager;
let USER = '';
let run = 0;
const DATE = '2026-03-10';
/** Vertragsfilter-Wechsel seit `from` (filtered_treaty_id bzw. „ohne“) */
const filterSwitches = (from: number) =>
  fake.requests
    .slice(from)
    .filter((q) => q.method === 'PATCH' && q.path.includes('filter_treaty'))
    .map((q) => /filtered_treaty_id=(\d+)/.exec(q.path)?.[1] ?? 'ohne');

beforeAll(async () => {
  fake = await startFakeProjo();
});
afterAll(async () => {
  await mgr?.shutdown();
  await fake.close();
});
beforeEach(async () => {
  await mgr?.shutdown();
  fake.bookings.clear();
  fake.state.rejectCsrf = false;
  fake.state.treeBroken = false;
  fake.state.lockedDays.clear();
  // eine vorhandene Buchung → Gesamtliste der Leistungen per edit_task verfügbar
  fake.seedBooking({ date: DATE, taskId: '6000001', minutes: 120 });
  const vault = new Vault(join(mkdtempSync(join(tmpdir(), 'time-')), 'vault'), randomBytes(32));
  // eindeutiger Nutzer je Test → keine Cache-Effekte (Leistungslisten, Bäume) zwischen Tests
  USER = `zeit-${++run}@example.com`;
  mgr = new ProjoSessionManager({ vault, baseUrl: fake.url, idleMs: 60_000, storePasswords: false, lockTimeoutMs: 15_000 });
  await mgr.connectWithPassword(USER, 'erika@example.com', 'geheim', false);
});

describe('Arbeitszeit buchen', () => {
  it('legt an, bestätigt per Nachlesen und verhindert Doppelbuchungen', async () => {
    const r = await createBooking(mgr, USER, { date: DATE, taskId: '6000002', hours: 1.25, description: 'Drucker eingerichtet' });
    expect(r.status).toBe('created');
    expect(r.booking).toMatchObject({ hours: 1.25, task: 'IT-Support', description: 'Drucker eingerichtet' });
    expect(r.day.totalHours).toBe(3.25);
    // CSRF wie rails-ujs: Meta-Token im Header (sonst hätte der Fake mit Turbo.visit(/login) geantwortet)
    const again = await createBooking(mgr, USER, { date: DATE, taskId: '6000002', hours: 1.25, description: 'Drucker eingerichtet' });
    expect(again.status).toBe('already_exists');
    expect(again.booking.id).toBe(r.booking.id);
    expect([...fake.bookings.values()].filter((b) => b.taskId === '6000002')).toHaveLength(1);
  });

  it('prüft Eingaben selbst, weil projo es nicht tut', async () => {
    await expect(createBooking(mgr, USER, { date: DATE, taskId: '6000002', hours: 1.3 })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(createBooking(mgr, USER, { date: DATE, taskId: '6000002', hours: 0 })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(createBooking(mgr, USER, { date: '2026-02-30', taskId: '6000002', hours: 1 })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(createBooking(mgr, USER, { date: DATE, taskId: '999', hours: 1 })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(fake.bookings.size).toBe(1);
  });

  it('unterscheidet abgelehntes CSRF-Token von abgelaufener Sitzung', async () => {
    fake.state.rejectCsrf = true;
    await expect(createBooking(mgr, USER, { date: DATE, taskId: '6000002', hours: 1 })).rejects.toMatchObject({ code: 'drift_detected' });
    expect(mgr.status(USER)).toMatchObject({ connected: true });
    expect(fake.bookings.size).toBe(1);
  });

  it('bucht auf Leistungen anderer Verträge (Liste per Vertragsfilter, Filter danach zurückgestellt)', async () => {
    const opts = await timeOptions(mgr, USER, { contract: '1000-Projekt-01', query: 'Kostensteuerung Süd' });
    expect(opts.source).toBe('vertrag');
    expect(opts.tasks).toEqual([
      expect.objectContaining({ taskId: '6100002', contract: '1000-Projekt-01', contractTitle: 'Neubau Musterschule', complete: true }),
    ]);
    expect(fake.activeTreaty()).toBe('700002');
    const r = await createBooking(mgr, USER, { date: DATE, taskId: '6100002', hours: 2 });
    expect(r.booking.label).toBe('1000-Projekt-01 - Leistungsstufe 2 - Kostenmanagement - Kostensteuerung zur Einhaltung der Kostenziele - Standort Süd');
  });

  it('findet über alle Verträge auch Wörter aus übergeordneten Ebenen (Leistungsbaum, in der Gesamtliste gekürzt)', async () => {
    const r = await timeOptions(mgr, USER, { query: 'Einhaltung Nord' });
    expect(r.tasks.map((t) => t.taskId)).toEqual(['6100001']);
    expect(r.source).toBe('leistungsbaum');
    expect(fake.activeTreaty()).toBe('700002');
  });
});

describe('Leistungen finden', () => {
  it('unterscheidet gleichnamige Leistungen über Nummer und Pfad – Filterwechsel nur für Verträge mit Treffern', async () => {
    const before = fake.requests.length;
    const r = await timeOptions(mgr, USER, { query: 'Standort Nord' });
    expect(r.tasks.map((t) => [t.taskId, t.number, t.leafName, t.path])).toEqual([
      ['6100001', '2.1.1.1', 'Standort Nord', ['Leistungsstufe 2', 'Kostenmanagement', 'Kostensteuerung zur Einhaltung der Kostenziele']],
      ['6100004', '2.1.2.1', 'Standort Nord', ['Leistungsstufe 2', 'Kostenmanagement', 'Kostenkontrolle']],
    ]);
    // nur Verträge mit Treffern statt aller Verträge der Person
    expect(r.contracts).toEqual([{ code: '1000-Projekt-01', title: 'Neubau Musterschule', matches: 2 }]);
    expect(filterSwitches(before)).toEqual(['700001', '700002']); // einmal hin, einmal zurück
    expect(fake.activeTreaty()).toBe('700002');
  });

  it('nennt gemeinsame obere Ebenen der Treffer einmal (commonPath statt Wiederholung)', async () => {
    const r = await timeOptions(mgr, USER, { query: 'Kostenmanagement Standort' });
    expect(r.tasks.map((t) => t.taskId)).toEqual(['6100001', '6100002', '6100004', '6100005']);
    expect(commonLevels(r.tasks)).toEqual(['Leistungsstufe 2', 'Kostenmanagement']);
    expect(commonLevels(r.tasks.slice(0, 2))).toEqual(['Leistungsstufe 2', 'Kostenmanagement', 'Kostensteuerung zur Einhaltung der Kostenziele']);
    expect(commonLevels(r.tasks.slice(0, 1))).toEqual([]);
  });

  it('sucht auch über die Gliederungsnummer und meldet den Status', async () => {
    const r = await timeOptions(mgr, USER, { query: '2.1.2.2' });
    expect(r.tasks).toEqual([expect.objectContaining({ taskId: '6100005', leafName: 'Standort Süd', status: 'nicht abrechenbar' })]);
  });

  it('Überblick ohne Parameter: alle Verträge + Leistungen des aktiven Vertrags mit Gliederung, ohne Filterwechsel', async () => {
    const before = fake.requests.length;
    const r = await timeOptions(mgr, USER, {});
    expect(r.contract).toEqual({ code: '2000-Intern-08', title: 'Interne Leistungen' });
    expect(r.contracts).toEqual([
      { code: '1000-Projekt-01', title: 'Neubau Musterschule', active: false },
      { code: '2000-Intern-08', title: 'Interne Leistungen', active: true },
    ]);
    expect(r.tasks.map((t) => [t.number, t.leafName, t.path])).toEqual([
      ['1', 'Hardware', []],
      ['2', 'IT-Support', []],
      ['3.1', 'Werkzeug A', ['Eigenentwicklungen']],
    ]);
    expect(filterSwitches(before)).toEqual([]);
  });

  it('ohne Treffer alle Verträge zum Eingrenzen – ohne Filterwechsel', async () => {
    const before = fake.requests.length;
    const r = await timeOptions(mgr, USER, { query: 'Gibtsnicht' });
    expect(r.matches).toBe(0);
    expect(r.contracts?.map((c) => c.code)).toEqual(['1000-Projekt-01', '2000-Intern-08']);
    expect(filterSwitches(before)).toEqual([]);
  });

  it('ohne lesbaren Leistungsbaum: Suche wie bisher über die Namen, Schnappschuss für die Reparatur', async () => {
    fake.state.treeBroken = true;
    const r = await timeOptions(mgr, USER, { query: 'Einhaltung Nord' });
    expect(r.source).toBe('je-vertrag');
    expect(r.tasks.map((t) => [t.taskId, t.number])).toEqual([['6100001', undefined]]);
    expect(fake.activeTreaty()).toBe('700002');
    expect(readdirSync(driftDir()).some((f) => f.endsWith('time_tree.html'))).toBe(true);
  });
});

describe('Arbeitszeit ändern und löschen', () => {
  it('ändert Dauer, Beschreibung und Leistung und bestätigt jede Änderung', async () => {
    const { booking } = await createBooking(mgr, USER, { date: DATE, taskId: '6000002', hours: 0.25, description: 'Test' });
    const r = await updateBooking(mgr, USER, { date: DATE, bookingId: booking.id!, hours: 0.5, description: 'Test (geändert)', taskId: '6000003' });
    expect(r.status).toBe('updated');
    expect(r.before).toMatchObject({ hours: 0.25, description: 'Test' });
    expect(r.booking).toMatchObject({ hours: 0.5, description: 'Test (geändert)', task: 'Eigenentwicklungen - Werkzeug A' });
  });

  it('meldet unbekannte Buchungen', async () => {
    await expect(updateBooking(mgr, USER, { date: DATE, bookingId: '123', hours: 1 })).rejects.toMatchObject({ code: 'not_found' });
    await expect(updateBooking(mgr, USER, { date: DATE, bookingId: '123' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('löscht genau eine Buchung', async () => {
    const { booking } = await createBooking(mgr, USER, { date: DATE, taskId: '6000002', hours: 1 });
    const r = await deleteBooking(mgr, USER, { date: DATE, bookingId: booking.id! });
    expect(r.status).toBe('deleted');
    expect(r.day.bookings.map((b) => b.id)).not.toContain(booking.id);
    await expect(deleteBooking(mgr, USER, { date: DATE, bookingId: booking.id! })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('Zeitbuchungen lesen', () => {
  it('liest Tage mit IDs und begrenzt Zeiträume', async () => {
    const r = await timeEntries(mgr, USER, DATE, '2026-03-11');
    expect(r.source).toBe('tagesansicht');
    expect(r.days).toEqual([{ date: DATE, bookings: [expect.objectContaining({ hours: 2, task: 'Hardware' })], totalHours: 2 }]);
    await expect(timeEntries(mgr, USER, '2026-01-01', '2026-12-31')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('liest Tage ohne Buchung im gesperrten Zeitraum als leer – ohne KI-Reserve und ohne degraded', async () => {
    fake.state.lockedDays.add('2026-10-26');
    fake.state.lockedDays.add('2026-10-27');
    const r = await timeEntries(mgr, USER, '2026-10-26', '2026-10-27');
    expect(r).toMatchObject({ source: 'tagesansicht', days: [], totalHours: 0 });
    expect(r.degraded).toBeUndefined();
  });
});
