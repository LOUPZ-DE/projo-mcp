import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { cleanText, extractHtmlFromJs, readableText, toInternalPath } from '../src/projo/util/dom.js';

describe('dom-Helfer', () => {
  it('normalisiert Whitespace inkl. &nbsp;', () => {
    expect(cleanText('  08:00 h \n\t ')).toBe('08:00 h');
    expect(cleanText(undefined)).toBe('');
  });

  it('lässt nur interne Pfade durch', () => {
    const base = 'https://my.projo.berlin';
    expect(toInternalPath('https://my.projo.berlin/app/dates/today?user_id=1', base)).toBe('/app/dates/today?user_id=1');
    expect(toInternalPath('/app/absences', base)).toBe('/app/absences');
    expect(toInternalPath('https://evil.example/app', base)).toBeUndefined();
    expect(toInternalPath('#', base)).toBeUndefined();
    expect(toInternalPath('javascript:void(0)', base)).toBeUndefined();
  });

  it('trennt Elementgrenzen im Text (kein „1 Tagvon 5 Tage“)', () => {
    const $ = cheerio.load('<table><tr><td>1 Tag<br><small>von 5 Tage</small></td></tr></table>');
    expect(readableText($('td').get(0))).toBe('1 Tag von 5 Tage');
  });

  it('holt HTML aus rails-ujs-JavaScript-Antworten und entschlüsselt escape_javascript', () => {
    const js = readFileSync(new URL('./fixtures/booking-created.js', import.meta.url), 'utf8');
    const html = extractHtmlFromJs(js);
    const $ = cheerio.load(html);
    expect($('tr#booking-900000003').length).toBe(1);
    expect(cleanText($('tr#booking-900000003 td').eq(2).text())).toBe('Drucker "Büro 2" eingerichtet – \'schnell\' & $sauber');
  });
});
