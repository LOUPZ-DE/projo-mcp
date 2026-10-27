import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../util/log.js';

/**
 * Sitzungs-Tresor: pro MCP-Nutzer eine AES-256-GCM-verschlüsselte Datei
 * `<dir>/<sha256(email)>.json` (Dateirechte 0600, Verzeichnis 0700).
 *
 * Inhalt: Projo-Cookies (Playwright-storageState) und – nur bei ausdrücklichem Opt-in und
 * Passwort-Login – das Projo-Passwort für die stille Neuanmeldung. Ein Microsoft-Passwort
 * wird nie gespeichert. Der Klartext verlässt den Server nie (weder an MCP-Client noch an ein LLM).
 */

/** Kompatibel zu Playwrights `storageState()` (Rückgabe und Eingabe von `newContext`). */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

export interface StorageState {
  cookies: StoredCookie[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}

export type ConnectMethod = 'password' | 'entra';

export interface VaultRecord {
  v: 1;
  /** Schlüssel: E-Mail der MCP-Identität (aus dem JWT), normalisiert */
  mcpEmail: string;
  /** Login-E-Mail bei Projo (kann von der MCP-E-Mail abweichen) */
  projoEmail: string;
  method: ConnectMethod;
  storageState: StorageState;
  /** Nur method=password + Opt-in */
  password?: string;
  projoUserName?: string;
  projoUserId?: string;
  connectedAt: string;
  lastValidatedAt?: string;
  lastUsedAt?: string;
}

interface VaultFile {
  v: 1;
  alg: 'A256GCM';
  iv: string;
  tag: string;
  data: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class Vault {
  constructor(
    private readonly dir: string,
    private readonly key: Buffer,
  ) {
    if (key.length !== 32) throw new Error('Vault-Schlüssel muss 32 Byte lang sein');
  }

  static userKey(email: string): string {
    return createHash('sha256').update(normalizeEmail(email)).digest('hex');
  }

  private file(email: string): string {
    return join(this.dir, `${Vault.userKey(email)}.json`);
  }

  private aad(userKey: string): Buffer {
    return Buffer.from(`projo-mcp/vault/v1/${userKey}`, 'utf8');
  }

  load(email: string): VaultRecord | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.file(email), 'utf8');
    } catch {
      return undefined;
    }
    return this.decrypt(Vault.userKey(email), raw);
  }

  save(record: VaultRecord): void {
    const email = normalizeEmail(record.mcpEmail);
    const userKey = Vault.userKey(email);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(userKey));
    const data = Buffer.concat([cipher.update(JSON.stringify({ ...record, mcpEmail: email }), 'utf8'), cipher.final()]);
    const file: VaultFile = {
      v: 1,
      alg: 'A256GCM',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const target = this.file(email);
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, target); // atomar
  }

  delete(email: string): boolean {
    try {
      rmSync(this.file(email));
      return true;
    } catch {
      return false;
    }
  }

  /** Alle entschlüsselbaren Einträge (für den Keep-alive). */
  list(): VaultRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => /^[0-9a-f]{64}\.json$/.test(n));
    } catch {
      return [];
    }
    const out: VaultRecord[] = [];
    for (const name of names) {
      try {
        const rec = this.decrypt(name.slice(0, 64), readFileSync(join(this.dir, name), 'utf8'));
        if (rec) out.push(rec);
      } catch {
        // gelesen werden nur gültige Dateien – Fehler sind in decrypt() geloggt
      }
    }
    return out;
  }

  private decrypt(userKey: string, raw: string): VaultRecord | undefined {
    try {
      const file = JSON.parse(raw) as VaultFile;
      if (file.v !== 1 || file.alg !== 'A256GCM') throw new Error(`unbekanntes Format v=${file.v}`);
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(file.iv, 'base64'));
      decipher.setAAD(this.aad(userKey));
      decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf8');
      const rec = JSON.parse(plain) as VaultRecord;
      if (rec.v !== 1 || Vault.userKey(rec.mcpEmail) !== userKey) throw new Error('Eintrag gehört nicht zu diesem Schlüssel');
      return rec;
    } catch (err) {
      // Falscher VAULT_KEY, Manipulation oder kaputte Datei → wie "nicht verbunden" behandeln
      log('warn', 'Vault: Eintrag nicht lesbar', { userKey: userKey.slice(0, 12), error: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  }
}
