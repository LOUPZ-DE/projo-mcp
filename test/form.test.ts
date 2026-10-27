import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { ProjoError } from '../src/projo/errors.js';
import { extractForm, parseFormErrors, serializeForm } from '../src/projo/form.js';

const BASE = 'https://my.projo.berlin';
const bookingNew = cheerio.load(readFileSync(new URL('./fixtures/booking-new.html', import.meta.url), 'utf8'));

describe('Formular-Engine', () => {
  it('liest das verschachtelte Buchungsformular wie ein Browser', () => {
    const form = extractForm(bookingNew, '#new_time_tracking_booking', BASE);
    expect(form.action).toBe('/app/bookings?date=2026-03-10&user_id=1001');
    expect(form.httpMethod).toBe('post');
    expect(form.remote).toBe(true);
    // Header-Token wie rails-ujs aus <meta>; das Feld authenticity_token bleibt im Body (siehe nächster Test)
    expect(form.csrfToken).toBe('meta-csrf-token');
    expect(form.controls.map((c) => c.name)).toEqual([
      'time_tracking_booking[duration_in_hour_min_str]',
      'authenticity_token',
      'time_tracking_booking[task_id]',
      'time_tracking_booking[description]',
    ]);
    expect(form.submitters).toEqual([{ name: 'commit', value: 'Arbeitszeit buchen' }]);
  });

  it('serialisiert mit Overrides in Dokumentreihenfolge', () => {
    const form = extractForm(bookingNew, '#new_time_tracking_booking', BASE);
    const fields = serializeForm(
      form,
      {
        'time_tracking_booking[duration_in_hour_min_str]': '01:15 h',
        'time_tracking_booking[task_id]': '6000002',
        'time_tracking_booking[description]': 'Drucker eingerichtet',
      },
      { submitter: 'commit' },
    );
    expect(fields).toEqual([
      ['time_tracking_booking[duration_in_hour_min_str]', '01:15 h'],
      ['authenticity_token', 'form-csrf-token'],
      ['time_tracking_booking[task_id]', '6000002'],
      ['time_tracking_booking[description]', 'Drucker eingerichtet'],
      ['commit', 'Arbeitszeit buchen'],
    ]);
  });

  it('nimmt ohne Auswahl die erste Option eines Selects (Browser-Verhalten)', () => {
    const form = extractForm(bookingNew, '#new_time_tracking_booking', BASE);
    const fields = Object.fromEntries(serializeForm(form));
    expect(fields['time_tracking_booking[task_id]']).toBe('');
    expect(fields['time_tracking_booking[duration_in_hour_min_str]']).toBe('00:00 h');
  });

  it('meldet Drift, wenn ein erwartetes Feld fehlt', () => {
    const form = extractForm(bookingNew, '#new_time_tracking_booking', BASE);
    expect(() => serializeForm(form, { 'time_tracking_booking[start_time]': '08:00' })).toThrowError(ProjoError);
    try {
      serializeForm(form, { 'time_tracking_booking[start_time]': '08:00' });
    } catch (err) {
      expect((err as ProjoError).code).toBe('drift_detected');
    }
  });

  it('behandelt das Rails-Checkbox-Muster (hidden 0 + checkbox 1)', () => {
    const $ = cheerio.load(`<form action="/x" method="post">
      <input type="hidden" name="_method" value="patch">
      <input type="hidden" name="a[flag]" value="0"><input type="checkbox" name="a[flag]" value="1">
      <input type="text" name="a[off]" value="x" disabled>
      <select name="a[tags][]" multiple><option value="1" selected>Eins</option><option value="2" selected>Zwei</option></select>
    </form>`);
    const form = extractForm($, 'form', BASE);
    expect(form.httpMethod).toBe('patch');
    expect(serializeForm(form)).toEqual([
      ['_method', 'patch'],
      ['a[flag]', '0'],
      ['a[tags][]', '1'],
      ['a[tags][]', '2'],
    ]);
    expect(serializeForm(form, { 'a[flag]': '1', 'a[tags][]': ['3'] })).toEqual([
      ['_method', 'patch'],
      ['a[flag]', '1'],
      ['a[tags][]', '3'],
    ]);
  });

  it('meldet fehlendes Formular als Drift', () => {
    expect(() => extractForm(bookingNew, '#gibt-es-nicht', BASE)).toThrowError(/nicht gefunden/);
  });

  it('liest Validierungsfehler', () => {
    const $ = cheerio.load('<div class="invalid-feedback">Dauer muss größer 0 sein</div><div class="alert alert-danger">Fehler beim Speichern</div>');
    expect(parseFormErrors($)).toEqual(['Dauer muss größer 0 sein', 'Fehler beim Speichern']);
  });
});
