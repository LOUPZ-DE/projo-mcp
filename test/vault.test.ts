import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Vault, type VaultRecord } from '../src/projo/vault.js';

const record = (email: string): VaultRecord => ({
  v: 1,
  mcpEmail: email,
  projoEmail: 'erika@example.com',
  method: 'password',
  storageState: { cookies: [{ name: '_projo_session', value: 'abc', domain: 'my.projo.berlin', path: '/', expires: 2_000_000_000, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [] },
  connectedAt: '2026-03-10T08:00:00.000Z',
});

function freshVault(key = randomBytes(32)) {
  const dir = join(mkdtempSync(join(tmpdir(), 'vault-')), 'vault');
  return { vault: new Vault(dir, key), dir, key };
}

describe('Vault', () => {
  it('speichert verschlüsselt und liest wieder (E-Mail normalisiert)', () => {
    const { vault, dir } = freshVault();
    vault.save(record('Erika@Example.com'));
    const loaded = vault.load('erika@example.com');
    expect(loaded?.projoEmail).toBe('erika@example.com');
    expect(loaded?.mcpEmail).toBe('erika@example.com');
    const [file] = readdirSync(dir);
    const raw = readFileSync(join(dir, file!), 'utf8');
    expect(raw).not.toContain('_projo_session');
    expect(raw).not.toContain('erika@example.com');
    expect(statSync(join(dir, file!)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('liefert nichts bei falschem Schlüssel', () => {
    const { vault, dir } = freshVault();
    vault.save(record('a@example.com'));
    expect(new Vault(dir, randomBytes(32)).load('a@example.com')).toBeUndefined();
  });

  it('erkennt Manipulation', () => {
    const { vault, dir } = freshVault();
    vault.save(record('a@example.com'));
    const [file] = readdirSync(dir);
    const path = join(dir, file!);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    const bytes = Buffer.from(data.data, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;
    data.data = bytes.toString('base64');
    writeFileSync(path, JSON.stringify(data));
    expect(vault.load('a@example.com')).toBeUndefined();
  });

  it('bindet Einträge an den Nutzer (umbenannte Datei ist unlesbar)', () => {
    const { vault, dir } = freshVault();
    vault.save(record('a@example.com'));
    const src = join(dir, `${Vault.userKey('a@example.com')}.json`);
    writeFileSync(join(dir, `${Vault.userKey('b@example.com')}.json`), readFileSync(src));
    expect(vault.load('b@example.com')).toBeUndefined();
  });

  it('listet und löscht Einträge', () => {
    const { vault } = freshVault();
    vault.save(record('a@example.com'));
    vault.save(record('b@example.com'));
    expect(vault.list().map((r) => r.mcpEmail).sort()).toEqual(['a@example.com', 'b@example.com']);
    expect(vault.delete('a@example.com')).toBe(true);
    expect(vault.delete('a@example.com')).toBe(false);
    expect(vault.list()).toHaveLength(1);
  });

  it('verlangt einen 32-Byte-Schlüssel', () => {
    expect(() => new Vault('/tmp/x', randomBytes(16))).toThrow();
  });
});
