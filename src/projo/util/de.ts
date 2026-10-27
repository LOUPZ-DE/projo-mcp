import { ProjoError } from '../errors.js';

/**
 * Deutsche Formate, wie projo sie rendert und erwartet.
 * Zeitdauern: "02:30 h", "-46:53 h", "+00:30 h", vereinzelt "1,50 h"; Daten: "10.03.2026", "Di, 10.03.".
 */

/** "02:30 h" → 2.5 · "-46:53 h" → -46.883… · "1,50 h" → 1.5 · sonst undefined */
export function parseDuration(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const t = text.replace(/ /g, ' ').trim();
  const hm = /^([+−-])?\s*(\d{1,4}):(\d{2})\s*h?$/.exec(t);
  if (hm) {
    const sign = hm[1] === '-' || hm[1] === '−' ? -1 : 1;
    return sign * (Number(hm[2]) + Number(hm[3]) / 60);
  }
  const dec = /^([+−-])?\s*(\d{1,4}(?:,\d+)?)\s*h$/.exec(t);
  if (dec) {
    const sign = dec[1] === '-' || dec[1] === '−' ? -1 : 1;
    return sign * Number(dec[2]!.replace(',', '.'));
  }
  return undefined;
}

/** Stunden auf 2 Nachkommastellen runden (Ausgabe an den Client). */
export const roundHours = (h: number): number => Math.round(h * 100) / 100;

/** 2.5 → "02:30 h" (Eingabeformat der projo-Dauerfelder) */
export function formatDuration(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} h`;
}

/** Dauer prüfen: > 0, ≤ 24 h, im 15-Minuten-Raster (wie der projo-Timepicker). */
export function assertBookableHours(hours: number): void {
  if (!Number.isFinite(hours) || hours <= 0) throw new ProjoError('invalid_input', 'Die Dauer muss größer als 0 Stunden sein.');
  if (hours > 24) throw new ProjoError('invalid_input', 'Die Dauer darf 24 Stunden nicht überschreiten.');
  if (Math.abs(hours * 4 - Math.round(hours * 4)) > 1e-9) {
    throw new ProjoError('invalid_input', `Die Dauer muss in 15-Minuten-Schritten angegeben werden (z. B. 1.25 statt ${hours}).`);
  }
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Prüft "YYYY-MM-DD" (echtes Kalenderdatum) und gibt es zurück. */
export function assertIsoDate(value: string, field = 'Datum'): string {
  const m = ISO.exec(value);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : undefined;
  if (!m || !d || d.toISOString().slice(0, 10) !== value) {
    throw new ProjoError('invalid_input', `${field} muss im Format YYYY-MM-DD angegeben werden (erhalten: ${value}).`);
  }
  return value;
}

/** "YYYY-MM-DD" + n Tage */
export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Anzahl Tage von a bis b (inklusive beider Enden) */
export function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** "2026-03-10" → "10.03.2026" */
export function toGermanDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** "10.03.2026" → "2026-03-10"; "Di, 10.03." mit Jahr aus dem Kontext */
export function parseGermanDate(text: string, contextYear?: number): string | undefined {
  const m = /(\d{1,2})\.(\d{1,2})\.(\d{4})?/.exec(text);
  if (!m) return undefined;
  const year = m[3] ? Number(m[3]) : contextYear;
  if (!year) return undefined;
  return `${year}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
}

/** "1.234,56" → 1234.56 · "7,58 %" → 7.58 */
export function parseGermanNumber(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = /-?\d{1,3}(?:\.\d{3})*(?:,\d+)?|-?\d+(?:,\d+)?/.exec(text.replace(/ /g, ' '));
  if (!m) return undefined;
  return Number(m[0].replace(/\./g, '').replace(',', '.'));
}

/** Heute in Europe/Berlin als YYYY-MM-DD */
export function todayBerlin(now = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(now);
}

/** Erster Tag jedes Monats im Bereich [from, to] als YYYY-MM-DD */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}
