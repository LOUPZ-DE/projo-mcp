import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { summarizePage } from '../src/projo/pages/generic.js';
import { parseProfile } from '../src/projo/pages/profile.js';

const BASE = 'https://my.projo.berlin';
const day = readFileSync(new URL('./fixtures/day.html', import.meta.url), 'utf8');
const bookingNew = readFileSync(new URL('./fixtures/booking-new.html', import.meta.url), 'utf8');

describe('summarizePage', () => {
  const s = summarizePage(day, { baseUrl: BASE, detail: 'compact' });

  it('liest die Buchungstabelle als Zeilen-Objekte inkl. IDs', () => {
    const t = s.tables[0]!;
    expect(t.headers).toEqual(['Dauer', 'Leistung', 'Rechnungskommentar', 'Spalte 4']);
    expect(t.rows[0]).toEqual({ Dauer: '02:30 h', Leistung: '1000-Projekt-01 - Planung - Leistungsphase 2', Rechnungskommentar: 'Abstimmung mit Fachplanern' });
    expect(t.meta[0]?.id).toBe('booking-900000001');
    expect(t.rows[2]).toEqual({ Dauer: '08:00 h' });
    expect(t.rowCount).toBe(3);
  });

  it('kennzeichnet Aktions-Links mit ihrer Methode', () => {
    expect(s.links).toContainEqual({ text: 'Abmelden', path: '/logout', method: 'delete' });
    expect(s.links).toContainEqual({ text: 'Arbeitszeiten des ganzen Tages löschen', path: '/app/dates/2026-03-10?user_id=1001', method: 'delete' });
    expect(s.links).toContainEqual({ text: 'Zeitbuchung', path: '/app/bookings/new?date=2026-03-10&user_id=1001' });
  });

  it('lässt Skripte, Navigation und Tabellen aus dem Resttext', () => {
    expect(s.text).not.toContain('nicht im Text erwarten');
    expect(s.text).not.toContain('Persönlicher Bereich');
    expect(s.text).not.toContain('Abstimmung mit Fachplanern');
    expect(s.text).toContain('Dienstag, 10.03.2026');
  });

  it('zeigt im Detailmodus Formularfelder, Optionen, Controller und data-URLs – ohne Token-Werte', () => {
    const full = summarizePage(bookingNew, { baseUrl: BASE, detail: 'full' });
    const form = full.forms[0]!;
    const task = form.fields.find((f) => f.name === 'time_tracking_booking[task_id]')!;
    expect(task.optionCount).toBe(5);
    expect(task.options?.[2]).toEqual({ value: '6000002', label: 'IT-Support' });
    expect(form.fields.find((f) => f.name === 'authenticity_token')?.value).toBe('<redacted>');
    expect(full.controllers).toContain('time-tracking-leaf');
    expect(full.lazyUrls).toContain('data-time-tracking-leaf-url=/time_tracking/leaves/5000002');
  });
});

describe('parseProfile', () => {
  it('liest Name, User-ID und Online-Status aus der Navigation', () => {
    expect(parseProfile(cheerio.load(day))).toEqual({ userId: '1001', name: 'Erika Mustermann', onlineStatus: 'angemeldet' });
  });
});
