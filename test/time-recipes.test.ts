import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBooking, deleteBooking, timeEntries, timeOptions, updateBooking } from '../src/projo/recipes/time.js';
import { ProjoSessionManager } from '../src/projo/session.js';
import { Vault } from '../src/projo/vault.js';
import { startFakeProjo, type FakeProjo } from './fake-projo/server.js';

/**
 * Schreib-Abläufe der Zeiterfassung gegen den Fake-projo – inkl. der in echt gefundenen Fallstricke:
 * fehlende Server-Validierung, CSRF über das Meta-Token, Filter-Wiederherstellung, Doppelbuchungen.
 */

let fake: FakeProjo;
let mgr: ProjoSessionManager;
const USER = 'zeit@example.com';
const DATE = '2026-03-10';

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
  // eine vorhandene Buchung → Gesamtliste der Leistungen per edit_task verfügbar
  fake.seedBooking({ date: DATE, taskId: '6000001', minutes: 120 });
  const vault = new Vault(join(mkdtempSync(join(tmpdir(), 'time-')), 'vault'), randomBytes(32));
  // eindeutiger Nutzer je Test → keine Cache-Effekte zwischen Tests
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

  it('findet über alle Verträge auch Wörter aus dem gekürzten Mittelteil der Gesamtliste', async () => {
    const r = await timeOptions(mgr, USER, { query: 'Einhaltung Nord' });
    expect(r.tasks.map((t) => t.taskId)).toEqual(['6100001']);
    expect(r.source).toBe('je-vertrag');
    expect(fake.activeTreaty()).toBe('700002');
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
});
