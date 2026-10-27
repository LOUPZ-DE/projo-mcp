import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProjoError, SessionExpiredError } from '../src/projo/errors.js';
import { ProjoHttp } from '../src/projo/http.js';
import { ProjoSessionManager, VALIDATE_PATH } from '../src/projo/session.js';
import { Vault } from '../src/projo/vault.js';
import { startFakeProjo, type FakeProjo } from './fake-projo/server.js';

let fake: FakeProjo;
let vault: Vault;
let mgr: ProjoSessionManager;

beforeAll(async () => {
  fake = await startFakeProjo();
});
afterAll(async () => {
  await mgr?.shutdown();
  await fake.close();
});
beforeEach(async () => {
  await mgr?.shutdown();
  vault = new Vault(join(mkdtempSync(join(tmpdir(), 'session-')), 'vault'), randomBytes(32));
  mgr = new ProjoSessionManager({ vault, baseUrl: fake.url, idleMs: 60_000, storePasswords: true, lockTimeoutMs: 15_000 });
  fake.requests.length = 0;
});

const MCP_USER = 'erika.mcp@example.com';

describe('HTTP-Treiber', () => {
  it('erkennt den Redirect auf /login als abgelaufene Sitzung', async () => {
    const http = await ProjoHttp.create({ baseUrl: fake.url });
    await expect(http.getPage(VALIDATE_PATH)).rejects.toBeInstanceOf(SessionExpiredError);
    await http.dispose();
  });

  it('weist fremde Hosts ab', async () => {
    const http = await ProjoHttp.create({ baseUrl: fake.url });
    await expect(http.getPage('https://evil.example/app')).rejects.toMatchObject({ code: 'blocked' });
    await http.dispose();
  });
});

describe('ProjoSessionManager', () => {
  it('meldet falsche Zugangsdaten mit der projo-Meldung', async () => {
    await expect(mgr.connectWithPassword(MCP_USER, 'erika@example.com', 'falsch', false)).rejects.toMatchObject({
      code: 'projo_login_failed',
      message: 'E-Mail oder Passwort ungültig',
    });
    expect(mgr.status(MCP_USER)).toEqual({ connected: false });
  });

  it('verbindet per Passwort und arbeitet mit der Sitzung', async () => {
    const status = await mgr.connectWithPassword(MCP_USER, 'erika@example.com', 'geheim', false);
    expect(status).toMatchObject({ connected: true, method: 'password', projoUserName: 'Erika Mustermann', projoUserId: '1001', passwordStored: false });
    expect(vault.load(MCP_USER)?.storageState.cookies.map((c) => c.name)).toContain('_projo_session');
    const profile = await mgr.validate(MCP_USER);
    expect(profile.name).toBe('Erika Mustermann');
    expect(vault.load(MCP_USER)?.lastUsedAt).toBeDefined();
  });

  it('verlangt ohne gespeichertes Passwort eine Neuverbindung, wenn die Sitzung abläuft', async () => {
    await mgr.connectWithPassword(MCP_USER, 'erika@example.com', 'geheim', false);
    fake.expireAll();
    await expect(mgr.validate(MCP_USER)).rejects.toMatchObject({ code: 'projo_login_required' });
    expect(mgr.status(MCP_USER)).toMatchObject({ connected: false, expired: true });
  });

  it('meldet sich mit gespeichertem Passwort still neu an', async () => {
    await mgr.connectWithPassword(MCP_USER, 'erika@example.com', 'geheim', true);
    fake.expireAll();
    fake.requests.length = 0;
    const profile = await mgr.validate(MCP_USER);
    expect(profile.userId).toBe('1001');
    expect(fake.requests.some((r) => r.method === 'POST' && r.path === '/login')).toBe(true);
    expect(mgr.status(MCP_USER)).toMatchObject({ connected: true, passwordStored: true });
  });

  it('serialisiert parallele Aufrufe derselben Person', async () => {
    await mgr.connectWithPassword(MCP_USER, 'erika@example.com', 'geheim', false);
    const before = fake.maxConcurrent();
    await Promise.all(Array.from({ length: 5 }, () => mgr.withUser(MCP_USER, ({ http }) => http.getPage(VALIDATE_PATH))));
    // Der Zähler misst global; vor diesem Test lief nichts parallel → bleibt bei 1
    expect(Math.max(before, fake.maxConcurrent())).toBe(1);
  });

  it('meldet fehlende Verbindung klar', async () => {
    await expect(mgr.withUser('niemand@example.com', async () => 1)).rejects.toBeInstanceOf(ProjoError);
    await expect(mgr.withUser('niemand@example.com', async () => 1)).rejects.toMatchObject({ code: 'projo_not_connected' });
  });

  it('trennt die Verbindung (Logout bei projo + Tresor-Eintrag weg)', async () => {
    await mgr.connectWithPassword(MCP_USER, 'erika@example.com', 'geheim', true);
    expect(await mgr.disconnect(MCP_USER)).toBe(true);
    expect(fake.requests.some((r) => r.method === 'POST' && r.path === '/logout' && r.body?._method === 'delete')).toBe(true);
    expect(mgr.status(MCP_USER)).toEqual({ connected: false });
  });
});
