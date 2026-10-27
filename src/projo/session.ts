import { Mutex, withTimeout, type MutexInterface } from 'async-mutex';
import { log } from '../util/log.js';
import { passwordLogin, type PasswordLoginResult } from './auth/password.js';
import { isProjoError, ProjoError, SessionExpiredError } from './errors.js';
import { csrfFromPage, ProjoHttp } from './http.js';
import { parseProfile, type ProjoProfile } from './pages/profile.js';
import { normalizeEmail, type ConnectMethod, type StorageState, type Vault, type VaultRecord } from './vault.js';

/**
 * Sitzungen aller Nutzer – ein Modul-Singleton (der MCP-Server selbst wird pro Request neu gebaut).
 *
 * - Pro Nutzer ein Mutex: Aufrufe werden serialisiert (Clients feuern parallel/mit Retries; projo-CSRF und
 *   Cookie-Rotation vertragen keine parallelen Writes derselben Sitzung).
 * - HTTP-Kontexte werden gecacht und nach Leerlauf geschlossen.
 * - Nach jedem Aufruf wird der (rollierende) Cookie-Stand in den Tresor zurückgeschrieben.
 * - Abgelaufene Sitzung → einmal still neu anmelden (gespeichertes Passwort bzw. SSO-Hook), sonst
 *   `projo_login_required` mit Link zur Verbindungsseite.
 */

/** Leichte Seite zum Prüfen der Sitzung (liefert Name + User-ID) */
export const VALIDATE_PATH = '/app/dates/today';

export interface SessionManagerOptions {
  vault: Vault;
  baseUrl: string;
  userAgent?: string;
  idleMs: number;
  storePasswords: boolean;
  keepMsCookies?: boolean;
  lockTimeoutMs?: number;
  /** für Tests austauschbar */
  createHttp?: (storageState?: StorageState) => Promise<ProjoHttp>;
  login?: (opts: { baseUrl: string; userAgent?: string; email: string; password: string }) => Promise<PasswordLoginResult>;
  /** stille SSO-Neuanmeldung (Microsoft) – wird vom Browser-Modul gesetzt */
  silentSso?: (record: VaultRecord) => Promise<VaultRecord | undefined>;
}

export interface ProjoUserContext {
  http: ProjoHttp;
  record: VaultRecord;
}

export interface ConnectionStatus {
  connected: boolean;
  expired?: boolean;
  method?: ConnectMethod;
  projoEmail?: string;
  projoUserName?: string;
  projoUserId?: string;
  connectedAt?: string;
  lastValidatedAt?: string;
  passwordStored?: boolean;
}

interface CachedClient {
  http: ProjoHttp;
  lastUsed: number;
  stateJson: string;
}

const PROJO_COOKIE_DOMAIN = (baseUrl: string) => new URL(baseUrl).hostname;

export class ProjoSessionManager {
  private readonly locks = new Map<string, MutexInterface>();
  private readonly clients = new Map<string, CachedClient>();
  private readonly sweepTimer: NodeJS.Timeout;
  private keepAliveTimer?: NodeJS.Timeout;

  constructor(private readonly opts: SessionManagerOptions) {
    this.sweepTimer = setInterval(() => void this.sweepIdle(), Math.min(60_000, opts.idleMs));
    this.sweepTimer.unref();
  }

  /** Hook für die stille Microsoft-Neuanmeldung (Browser-Modul, nachträglich gesetzt). */
  setSilentSso(fn: SessionManagerOptions['silentSso']): void {
    this.opts.silentSso = fn;
  }

  // ─── Status & Verbinden ────────────────────────────────────────────────────

  status(mcpEmail: string): ConnectionStatus {
    const rec = this.opts.vault.load(mcpEmail);
    if (!rec) return { connected: false };
    return {
      connected: !rec.sessionExpiredAt,
      ...(rec.sessionExpiredAt ? { expired: true } : {}),
      method: rec.method,
      projoEmail: rec.projoEmail,
      ...(rec.projoUserName ? { projoUserName: rec.projoUserName } : {}),
      ...(rec.projoUserId ? { projoUserId: rec.projoUserId } : {}),
      connectedAt: rec.connectedAt,
      ...(rec.lastValidatedAt ? { lastValidatedAt: rec.lastValidatedAt } : {}),
      passwordStored: Boolean(rec.password),
    };
  }

  async connectWithPassword(mcpEmail: string, projoEmail: string, password: string, storePassword: boolean): Promise<ConnectionStatus> {
    const email = normalizeEmail(mcpEmail);
    await this.lock(email).runExclusive(async () => {
      const login = this.opts.login ?? passwordLogin;
      const { storageState, profile } = await login({ baseUrl: this.opts.baseUrl, userAgent: this.opts.userAgent, email: projoEmail, password });
      const now = new Date().toISOString();
      await this.dropClient(email);
      this.opts.vault.save({
        v: 1,
        mcpEmail: email,
        projoEmail: projoEmail.trim(),
        method: 'password',
        storageState,
        ...(storePassword && this.opts.storePasswords ? { password } : {}),
        ...(profile.name ? { projoUserName: profile.name } : {}),
        ...(profile.userId ? { projoUserId: profile.userId } : {}),
        connectedAt: now,
        lastValidatedAt: now,
      });
    });
    return this.status(email);
  }

  /** Ergebnis eines Browser-Logins (Microsoft-SSO) übernehmen. */
  async connectWithStorageState(mcpEmail: string, projoEmail: string, method: ConnectMethod, storageState: StorageState, profile: ProjoProfile): Promise<ConnectionStatus> {
    const email = normalizeEmail(mcpEmail);
    const domain = PROJO_COOKIE_DOMAIN(this.opts.baseUrl);
    const cookies = this.opts.keepMsCookies ? storageState.cookies : storageState.cookies.filter((c) => c.domain.replace(/^\./, '') === domain);
    await this.lock(email).runExclusive(async () => {
      const now = new Date().toISOString();
      await this.dropClient(email);
      this.opts.vault.save({
        v: 1,
        mcpEmail: email,
        projoEmail: projoEmail.trim(),
        method,
        storageState: { cookies, origins: [] },
        ...(profile.name ? { projoUserName: profile.name } : {}),
        ...(profile.userId ? { projoUserId: profile.userId } : {}),
        connectedAt: now,
        lastValidatedAt: now,
      });
    });
    return this.status(email);
  }

  /** Abmelden bei projo (best effort) und Tresor-Eintrag löschen. */
  async disconnect(mcpEmail: string): Promise<boolean> {
    const email = normalizeEmail(mcpEmail);
    return this.lock(email).runExclusive(async () => {
      const rec = this.opts.vault.load(email);
      if (!rec) return false;
      try {
        const client = await this.client(email, rec);
        const page = await client.http.getPage(VALIDATE_PATH);
        const csrf = csrfFromPage(page.$);
        if (csrf) await client.http.send('POST', '/logout', { form: [['_method', 'delete'], ['authenticity_token', csrf]] });
      } catch {
        // Sitzung evtl. schon abgelaufen – Löschen des Eintrags reicht
      }
      await this.dropClient(email);
      return this.opts.vault.delete(email);
    });
  }

  // ─── Arbeiten mit der Sitzung ──────────────────────────────────────────────

  /**
   * Führt `fn` exklusiv mit der projo-Sitzung des Nutzers aus. Bei abgelaufener Sitzung genau ein
   * Neuversuch nach stiller Neuanmeldung (sicher auch für Writes: projo hat vor der Aktion auf /login umgeleitet).
   */
  async withUser<T>(mcpEmail: string, fn: (ctx: ProjoUserContext) => Promise<T>): Promise<T> {
    const email = normalizeEmail(mcpEmail);
    return this.lock(email).runExclusive(async () => {
      let record = this.opts.vault.load(email);
      if (!record) throw new ProjoError('projo_not_connected', 'Für dich ist noch kein projo-Konto verbunden.');

      let client = await this.client(email, record);
      try {
        const result = await fn({ http: client.http, record });
        await this.persist(email, record, client, true);
        return result;
      } catch (err) {
        if (!(err instanceof SessionExpiredError)) {
          await this.persist(email, record, client, false).catch(() => undefined);
          throw err;
        }
        // Wirklich abgelaufen? Ein abgelehntes CSRF-Token sieht für projo genauso aus („nicht angemeldet“).
        try {
          await client.http.getPage(VALIDATE_PATH);
          await this.persist(email, record, client, true).catch(() => undefined);
          throw new ProjoError(
            'drift_detected',
            'projo hat die Aktion als „nicht angemeldet“ abgelehnt, obwohl die Sitzung gültig ist (vermutlich Sicherheits-Token) – der Ablauf muss geprüft werden.',
          );
        } catch (check) {
          if (!(check instanceof SessionExpiredError)) throw check;
        }
      }

      // Sitzung abgelaufen → stille Neuanmeldung
      await this.dropClient(email);
      const renewed = await this.silentRelogin(record);
      if (!renewed) {
        this.opts.vault.save({ ...record, sessionExpiredAt: new Date().toISOString() });
        throw new ProjoError('projo_login_required', 'Die projo-Sitzung ist abgelaufen – bitte das projo-Konto neu verbinden.');
      }
      record = renewed;
      this.opts.vault.save(record);
      client = await this.client(email, record);
      const result = await fn({ http: client.http, record });
      await this.persist(email, record, client, true);
      return result;
    });
  }

  /** Sitzung live prüfen; aktualisiert Name/User-ID im Tresor. */
  async validate(mcpEmail: string): Promise<ProjoProfile> {
    return this.withUser(mcpEmail, async ({ http, record }) => {
      const page = await http.getPage(VALIDATE_PATH);
      const profile = parseProfile(page.$);
      if (profile.name) record.projoUserName = profile.name;
      if (profile.userId) record.projoUserId = profile.userId;
      return profile;
    });
  }

  /** Projo-User-ID der Sitzung (für Routen mit `user_id=`); ermittelt sie bei Bedarf live. */
  async userId(ctx: ProjoUserContext): Promise<string> {
    if (ctx.record.projoUserId) return ctx.record.projoUserId;
    const page = await ctx.http.getPage(VALIDATE_PATH);
    const profile = parseProfile(page.$);
    if (!profile.userId) throw new ProjoError('drift_detected', 'Die projo-User-ID ließ sich nicht ermitteln.');
    ctx.record.projoUserId = profile.userId;
    return profile.userId;
  }

  // ─── Keep-alive & Lebenszyklus ─────────────────────────────────────────────

  /** projo verlängert `_projo_session` bei jedem Request um 14 Tage – ein regelmäßiger GET hält Sitzungen aktiv. */
  startKeepAlive(hours: number): void {
    if (hours <= 0 || this.keepAliveTimer) return;
    this.keepAliveTimer = setInterval(() => void this.keepAliveAll(), hours * 3_600_000);
    this.keepAliveTimer.unref();
  }

  async keepAliveAll(): Promise<{ ok: number; failed: number }> {
    let ok = 0;
    let failed = 0;
    for (const rec of this.opts.vault.list()) {
      if (rec.sessionExpiredAt) continue;
      try {
        await this.validate(rec.mcpEmail);
        ok++;
      } catch (err) {
        failed++;
        log('warn', 'Keep-alive fehlgeschlagen', { user: rec.mcpEmail, code: isProjoError(err) ? err.code : 'error' });
      }
    }
    if (ok + failed > 0) log('info', 'Keep-alive abgeschlossen', { ok, failed });
    return { ok, failed };
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sweepTimer);
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    await Promise.all([...this.clients.keys()].map((k) => this.dropClient(k)));
  }

  // ─── intern ────────────────────────────────────────────────────────────────

  private lock(email: string): MutexInterface {
    let m = this.locks.get(email);
    if (!m) {
      m = withTimeout(
        new Mutex(),
        this.opts.lockTimeoutMs ?? 60_000,
        new ProjoError('projo_unavailable', 'Eine andere projo-Aktion für dich läuft noch – bitte gleich erneut versuchen.'),
      );
      this.locks.set(email, m);
    }
    return m;
  }

  private async client(email: string, record: VaultRecord): Promise<CachedClient> {
    const cached = this.clients.get(email);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached;
    }
    const create = this.opts.createHttp ?? ((state?: StorageState) => ProjoHttp.create({ baseUrl: this.opts.baseUrl, userAgent: this.opts.userAgent, storageState: state }));
    const http = await create(record.storageState);
    const entry = { http, lastUsed: Date.now(), stateJson: JSON.stringify(record.storageState) };
    this.clients.set(email, entry);
    return entry;
  }

  private async persist(email: string, record: VaultRecord, client: CachedClient, validated: boolean): Promise<void> {
    client.lastUsed = Date.now();
    const state = await client.http.storageState();
    const json = JSON.stringify(state);
    const now = new Date().toISOString();
    const next: VaultRecord = { ...record, lastUsedAt: now, ...(validated ? { lastValidatedAt: now } : {}) };
    delete next.sessionExpiredAt;
    if (json !== client.stateJson) {
      next.storageState = state;
      client.stateJson = json;
    }
    this.opts.vault.save(next);
    Object.assign(record, next);
    delete record.sessionExpiredAt;
  }

  private async silentRelogin(record: VaultRecord): Promise<VaultRecord | undefined> {
    const now = new Date().toISOString();
    if (record.method === 'password' && record.password) {
      try {
        const login = this.opts.login ?? passwordLogin;
        const { storageState, profile } = await login({ baseUrl: this.opts.baseUrl, userAgent: this.opts.userAgent, email: record.projoEmail, password: record.password });
        log('info', 'projo: stille Neuanmeldung erfolgreich', { user: record.mcpEmail });
        const next: VaultRecord = { ...record, storageState, lastValidatedAt: now };
        if (profile.name) next.projoUserName = profile.name;
        if (profile.userId) next.projoUserId = profile.userId;
        delete next.sessionExpiredAt;
        return next;
      } catch (err) {
        log('warn', 'projo: stille Neuanmeldung fehlgeschlagen', { user: record.mcpEmail, code: isProjoError(err) ? err.code : 'error' });
        return undefined;
      }
    }
    if (record.method === 'entra' && this.opts.silentSso) {
      return this.opts.silentSso(record).catch(() => undefined);
    }
    return undefined;
  }

  private async dropClient(email: string): Promise<void> {
    const c = this.clients.get(email);
    if (!c) return;
    this.clients.delete(email);
    await c.http.dispose();
  }

  private async sweepIdle(): Promise<void> {
    const cutoff = Date.now() - this.opts.idleMs;
    for (const [email, c] of this.clients) {
      if (c.lastUsed < cutoff) await this.dropClient(email);
    }
  }
}
