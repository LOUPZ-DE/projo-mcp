import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { log } from '../util/log.js';

// ─── Typen ───────────────────────────────────────────────────────────────────

export interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope?: string;
}

export interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope?: string;
  resource?: string;
  email: string;
  name: string;
  /** Woher die Identität stammt: 'local' | 'google' | 'entra' */
  idp?: string;
  /** Notion sendet beim Authorize-Request eine notion_user_id — durchgereicht bis in den JWT. */
  notionUserId?: string;
  expiresAt: number; // unix ms
}

export interface RefreshToken {
  clientId: string;
  email: string;
  name: string;
  scope?: string;
  resource?: string;
  idp?: string;
  notionUserId?: string;
  expiresAt: number; // unix ms
}

export interface PendingAuth {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  scope?: string;
  resource?: string;
  notionUserId?: string;
  expiresAt: number; // unix ms
}

/** Kurzlebige Transaktion für den IdP-Flow (SSO) — key = state, der zum IdP gesendet wird. */
export interface IdpTxn {
  /** Referenz auf den Key in pendingAuths (unser Flow Richtung Notion) */
  txn: string;
  providerKey: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number; // unix ms
}

export interface User {
  email: string;
  password: string;
  name: string;
}

// ─── In-Memory Maps ──────────────────────────────────────────────────────────

/** Langlebig → wird ins Statefile persistiert. */
export const clients = new Map<string, RegisteredClient>();
/** Langlebig → wird ins Statefile persistiert. */
export const refreshTokens = new Map<string, RefreshToken>();

/** Kurzlebig (10 min) — bleibt bewusst flüchtig. */
export const authCodes = new Map<string, AuthCode>();
/** Kurzlebig (10 min) — bleibt bewusst flüchtig. */
export const pendingAuths = new Map<string, PendingAuth>();
/** Kurzlebig (10 min) — SSO-Transaktionen, key = state zum IdP. */
export const idpTxns = new Map<string, IdpTxn>();

/** Nutzer aus USERS_JSON (Env ist Source of Truth) — nur für den 'local'-Provider. */
export const users = new Map<string, User>(config.USERS.map((u) => [u.email.toLowerCase(), u]));

// ─── Lazy Expiry + Sweep ─────────────────────────────────────────────────────

function getLive<K, V extends { expiresAt: number }>(map: Map<K, V>, key: K, onExpire?: () => void): V | undefined {
  const value = map.get(key);
  if (!value) return undefined;
  if (value.expiresAt <= Date.now()) {
    map.delete(key);
    onExpire?.();
    return undefined;
  }
  return value;
}

export const getClient = (id: string) => clients.get(id);
export const getAuthCode = (code: string) => getLive(authCodes, code);
export const getRefreshToken = (token: string) => getLive(refreshTokens, token, scheduleSave);
export const getPendingAuth = (txn: string) => getLive(pendingAuths, txn);
export const getIdpTxn = (state: string) => getLive(idpTxns, state);

const sweep = setInterval(() => {
  const now = Date.now();
  let removedRefresh = 0;
  for (const [k, v] of authCodes) if (v.expiresAt <= now) authCodes.delete(k);
  for (const [k, v] of pendingAuths) if (v.expiresAt <= now) pendingAuths.delete(k);
  for (const [k, v] of idpTxns) if (v.expiresAt <= now) idpTxns.delete(k);
  for (const [k, v] of refreshTokens) if (v.expiresAt <= now) { refreshTokens.delete(k); removedRefresh++; }
  if (removedRefresh > 0) scheduleSave();
}, 5 * 60 * 1000);
sweep.unref();

// ─── Statefile-Persistenz (clients + refreshTokens) ─────────────────────────

const STATE_VERSION = 1;

interface StateFileData {
  version: number;
  clients: [string, RegisteredClient][];
  refreshTokens: [string, RefreshToken][];
}

export function loadState(): void {
  if (!config.STATE_FILE) return;
  let raw: string;
  try {
    raw = readFileSync(config.STATE_FILE, 'utf8');
  } catch {
    log('info', 'Kein Statefile gefunden — starte mit frischem State', { stateFile: config.STATE_FILE });
    return;
  }
  try {
    const data = JSON.parse(raw) as StateFileData;
    if (data.version !== STATE_VERSION) throw new Error(`unsupported version ${data.version}`);
    for (const [k, v] of data.clients) clients.set(k, v);
    const now = Date.now();
    let skipped = 0;
    for (const [k, v] of data.refreshTokens) {
      if (v.expiresAt > now) refreshTokens.set(k, v);
      else skipped++;
    }
    log('info', 'Statefile geladen', {
      stateFile: config.STATE_FILE,
      clients: clients.size,
      refreshTokens: refreshTokens.size,
      expiredRefreshTokensSkipped: skipped,
    });
  } catch (err) {
    log('warn', 'Statefile korrupt/inkompatibel — starte mit frischem State', {
      stateFile: config.STATE_FILE,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

let saveTimer: NodeJS.Timeout | null = null;

/** Debounced Save (~1 s) — bei jeder Mutation von clients/refreshTokens aufrufen. */
export function scheduleSave(): void {
  if (!config.STATE_FILE || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 1000);
  saveTimer.unref();
}

function saveNow(): void {
  if (!config.STATE_FILE) return;
  const data: StateFileData = {
    version: STATE_VERSION,
    clients: [...clients],
    refreshTokens: [...refreshTokens],
  };
  try {
    mkdirSync(dirname(config.STATE_FILE), { recursive: true });
    const tmp = `${config.STATE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), 'utf8');
    renameSync(tmp, config.STATE_FILE); // atomar
    log('debug', 'Statefile geschrieben', { stateFile: config.STATE_FILE, clients: clients.size, refreshTokens: refreshTokens.size });
  } catch (err) {
    log('error', 'Statefile konnte nicht geschrieben werden', {
      stateFile: config.STATE_FILE,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
