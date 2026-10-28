import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { driftDir } from '../src/harness/drift.js';
import { parseWithFallback } from '../src/harness/fallback.js';
import type { JsonRequest, LlmClient } from '../src/harness/llm.js';
import { condenseHtml } from '../src/harness/sanitize.js';
import { ProjoError } from '../src/projo/errors.js';
import { analysisSpec, daySpec } from '../src/projo/pages/time-fallback.js';

const fakeClient = (answer: unknown): LlmClient & { calls: JsonRequest[] } => {
  const calls: JsonRequest[] = [];
  return {
    model: 'fake/model',
    calls,
    async json<T>(req: JsonRequest): Promise<T> {
      calls.push(req);
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
  };
};

const drift = () => {
  throw new ProjoError('drift_detected', 'Tabelle fehlt');
};

afterEach(() => {
  rmSync(driftDir(), { recursive: true, force: true });
});

describe('condenseHtml (Datensparsamkeit)', () => {
  it('entfernt Skripte, Tokens, Passwörter und maskiert E-Mails', () => {
    const out = condenseHtml(`<html><head><title>x</title><meta name="csrf-token" content="geheim"></head><body>
      <script>var token = "geheim";</script>
      <nav>Menü</nav>
      <form><input type="hidden" name="authenticity_token" value="geheim"><input type="password" name="p" value="pw"></form>
      <table class="t" style="x"><tr id="booking-1" data-row-id="1" onclick="x()"><td title="IT-Support">erika@example.com</td>
      <td><a href="https://my.projo.berlin/app/dates/2026-03-10">Tag</a></td></tr></table></body></html>`);
    expect(out).not.toContain('geheim');
    expect(out).not.toContain('pw');
    expect(out).not.toContain('Menü');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('class=');
    expect(out).toContain('<email>');
    expect(out).toContain('id="booking-1"');
    expect(out).toContain('title="IT-Support"');
    expect(out).toContain('href="/app/dates/2026-03-10"');
  });
});

describe('parseWithFallback', () => {
  it('nutzt das LLM nicht, solange der feste Parser funktioniert', async () => {
    const client = fakeClient({});
    const r = await parseWithFallback('<p/>', () => 42, { key: 'x', task: 'x', schema: {}, map: () => 0 }, client);
    expect(r).toEqual({ value: 42, degraded: false });
    expect(client.calls).toHaveLength(0);
  });

  it('springt bei Drift ein, markiert das Ergebnis und legt einen Schnappschuss ab', async () => {
    const client = fakeClient({ bookings: [{ id: 'booking-7', hours: 2.5, label: '1000-Projekt-01 - Planung', task: 'Planung', description: null }] });
    const r = await parseWithFallback('<table><tr id="booking-7"><td>02:30 h</td></tr></table>', drift, daySpec('2026-03-10'), client);
    expect(r.degraded).toBe(true);
    expect(r.value).toEqual({
      date: '2026-03-10',
      bookings: [{ id: '7', hours: 2.5, label: '1000-Projekt-01 - Planung', contract: '1000-Projekt-01', task: 'Planung' }],
      totalHours: 2.5,
    });
    expect(client.calls[0]?.schemaName).toBe('time_day');
    expect(client.calls[0]?.user).toContain('id="booking-7"');
    await vi.waitFor(() => expect(client.calls).toHaveLength(2)); // Reparaturvorschlag im Hintergrund
    const files = readdirSync(driftDir());
    const snapshot = files.find((f) => f.endsWith('time_day.html'))!;
    expect(statSync(join(driftDir(), snapshot)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(driftDir(), snapshot), 'utf8')).toContain('Tabelle fehlt');
  });

  it('reicht andere Fehler unverändert durch – ohne LLM-Aufruf', async () => {
    const client = fakeClient({});
    await expect(
      parseWithFallback('<p/>', () => { throw new ProjoError('projo_forbidden', 'nein'); }, daySpec('2026-03-10'), client),
    ).rejects.toMatchObject({ code: 'projo_forbidden' });
    expect(client.calls).toHaveLength(0);
  });

  it('meldet die ursprüngliche Drift, wenn kein LLM konfiguriert ist oder es scheitert', async () => {
    await expect(parseWithFallback('<p/>', drift, daySpec('2026-03-10'), undefined)).rejects.toMatchObject({ code: 'drift_detected', message: 'Tabelle fehlt' });
    await expect(parseWithFallback('<p/>', drift, daySpec('2026-03-10'), fakeClient(new Error('timeout')))).rejects.toMatchObject({
      code: 'drift_detected',
      message: 'Tabelle fehlt',
    });
  });

  it('überführt die Auswertung „Stunden pro Projekt“ ins Parser-Format', async () => {
    const client = fakeClient({
      projects: [{ project: '1000-Projekt', title: 'Neubau Musterschule', hours: 110, percent: 83.33 }],
      absences: [{ type: 'Urlaub', hours: 24 }],
      totals: [{ label: 'Sollstunden', hours: 152 }],
    });
    const r = await parseWithFallback('<table/>', drift, analysisSpec(), client);
    expect(r.value).toEqual({
      projects: [{ project: '1000-Projekt', title: 'Neubau Musterschule', hours: 110, percent: 83.33 }],
      absences: [{ type: 'Urlaub', hours: 24 }],
      totals: { Sollstunden: 152 },
    });
  });
});
