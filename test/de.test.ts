import { describe, expect, it } from 'vitest';
import {
  addDays,
  assertBookableHours,
  assertIsoDate,
  daysInclusive,
  formatDuration,
  monthsBetween,
  parseDuration,
  parseGermanDate,
  parseGermanNumber,
  toGermanDate,
  todayBerlin,
} from '../src/projo/util/de.js';

describe('Dauern', () => {
  it.each([
    ['08:30 h', 8.5],
    ['10:00 h', 10],
    ['24:00 h', 24],
    ['152:00 h', 152],
    ['1234:15 h', 1234.25],
    ['-46:53 h', -(46 + 53 / 60)],
    ['+00:30 h', 0.5],
    ['−02:00 h', -2],
    ['1,50 h', 1.5],
    ['00:00 h', 0],
  ])('liest %s', (text, hours) => {
    expect(parseDuration(text)).toBeCloseTo(hours, 6);
  });

  it('erkennt Nicht-Dauern', () => {
    expect(parseDuration('dfsdf')).toBeUndefined();
    expect(parseDuration('')).toBeUndefined();
    expect(parseDuration('Sollstunden')).toBeUndefined();
  });

  it('formatiert für projo-Eingabefelder', () => {
    expect(formatDuration(2.5)).toBe('02:30 h');
    expect(formatDuration(0.25)).toBe('00:15 h');
    expect(formatDuration(10)).toBe('10:00 h');
  });

  it('prüft buchbare Dauern (15-Minuten-Raster, 0 < h ≤ 24)', () => {
    expect(() => assertBookableHours(1.25)).not.toThrow();
    expect(() => assertBookableHours(0)).toThrowError(/größer als 0/);
    expect(() => assertBookableHours(1.3)).toThrowError(/15-Minuten/);
    expect(() => assertBookableHours(25)).toThrowError(/24 Stunden/);
  });
});

describe('Daten & Zahlen', () => {
  it('prüft ISO-Daten streng', () => {
    expect(assertIsoDate('2026-03-10')).toBe('2026-03-10');
    expect(() => assertIsoDate('2026-02-30')).toThrow();
    expect(() => assertIsoDate('10.03.2026')).toThrow();
  });

  it('rechnet mit Tagen und Monaten', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(daysInclusive('2026-03-01', '2026-03-10')).toBe(10);
    expect(monthsBetween('2025-11-15', '2026-02-03')).toEqual(['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01']);
  });

  it('wandelt deutsche Formate', () => {
    expect(toGermanDate('2026-03-10')).toBe('10.03.2026');
    expect(parseGermanDate('Di, 10.03.', 2026)).toBe('2026-03-10');
    expect(parseGermanDate('05.03.2026')).toBe('2026-03-05');
    expect(parseGermanNumber('7,58 %')).toBe(7.58);
    expect(parseGermanNumber('1.234,56 €')).toBe(1234.56);
  });

  it('kennt „heute“ in Berlin', () => {
    expect(todayBerlin(new Date('2026-03-10T23:30:00Z'))).toBe('2026-03-11');
  });
});
