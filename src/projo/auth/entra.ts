import * as cheerio from 'cheerio';
import type { Page } from 'playwright';
import { log } from '../../util/log.js';
import type { BrowserPool } from '../browser.js';
import { isProjoError, ProjoError } from '../errors.js';
import { isLoginPath } from '../http.js';
import { parseProfile, type ProjoProfile } from '../pages/profile.js';
import type { ConnectionStatus, ProjoSessionManager } from '../session.js';
import type { StorageState, VaultRecord } from '../vault.js';
import { cleanText } from '../util/dom.js';

/**
 * „Mit Microsoft anmelden“ bei projo – ausgeführt im Server-Browser, gesteuert über die Verbindungsseite.
 *
 * Ablauf: projo /login → POST /auth/entra_id → login.microsoftonline.com: E-Mail → Passwort → MFA
 * (Zahl für die Authenticator-App anzeigen bzw. Code abfragen) → „Angemeldet bleiben?“ → zurück zu projo.
 * Die Microsoft-Seiten sind nicht dokumentiert – jeder Schritt wird über sichtbare Elemente erkannt,
 * unbekannte Seiten führen nach kurzer Zeit zu einer klaren Fehlermeldung statt zu Raterei.
 * Das Microsoft-Passwort lebt nur im Speicher dieses Jobs und wird danach verworfen.
 */

export type EntraJobState = 'starting' | 'microsoft' | 'awaiting_approval' | 'awaiting_code' | 'finishing' | 'done' | 'failed';

export interface EntraJobStatus {
  state: EntraJobState;
  message: string;
  /** Zahl, die in der Authenticator-App eingegeben werden muss (Number Matching) */
  number?: string;
  startedAt: string;
  updatedAt: string;
}

const JOB_TIMEOUT_MS = 5 * 60_000;
const APPROVAL_TIMEOUT_MS = 2 * 60_000;
const CODE_TIMEOUT_MS = 3 * 60_000;
const MS_HOST = /^https:\/\/login\.(microsoftonline|live|microsoft)\.com\//;

type Step =
  | { kind: 'email' }
  | { kind: 'password' }
  | { kind: 'push'; number?: string }
  | { kind: 'otp'; error?: string }
  | { kind: 'proof_choice' }
  | { kind: 'kmsi' }
  | { kind: 'account_picker' }
  | { kind: 'fido' }
  | { kind: 'interrupt' }
  | { kind: 'error'; message: string }
  | { kind: 'unknown' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SKIP_TEXT = /^(jetzt nicht|später|überspringen|nicht jetzt|später erinnern|skip|skip for now|not now|ask later|maybe later)$/i;

/**
 * Ein Server-Browser hat keinen Passkey/Sicherheitsschlüssel. Ohne diese Zeilen leitet Microsoft Konten mit
 * Passkey auf /common/bridge/fido um – mit ihnen fällt es auf Authenticator-Push bzw. Passwort + MFA zurück.
 */
const NO_WEBAUTHN_SCRIPT = `try { Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true }); } catch (e) {}
try { if (navigator.credentials) { const no = () => Promise.reject(new DOMException('not supported', 'NotSupportedError')); navigator.credentials.get = no; navigator.credentials.create = no; } } catch (e) {}`;

/**
 * Erkennung der Microsoft-Seite. Bewusst als TEXT übergeben: tsx/esbuild schreiben Funktionen sonst mit
 * __name()-Helfern um, die im Browser fehlen („__name is not defined“).
 * Sichtbar = gerendert UND im Viewport (Microsoft parkt Felder per .moveOffScreen außerhalb).
 */
const DETECT_SCRIPT = `(() => {
  const vis = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.left < innerWidth && r.top < innerHeight;
  };
  const first = (sel) => [...document.querySelectorAll(sel)].find(vis);
  const v = (sel) => Boolean(first(sel));
  const t = (sel) => { const el = first(sel); return el ? (el.textContent || '').trim() : ''; };
  const skip = new RegExp(${JSON.stringify(SKIP_TEXT.source)}, 'i');
  return {
    path: location.pathname,
    number: t('#idRichContext_DisplaySign, #idRemoteNGC_DisplaySign, [id$="_DisplaySign"], .displaySign'),
    pushWaiting: v('#idDiv_SAOTCAS_Description, #idDiv_RemoteNGC_PollingDescription, #idRemoteNGC_DisplaySign'),
    denied: t('#idDiv_SAASDS_Description'),
    timedOut: t('#idDiv_SAASTO_Description'),
    otc: v('input[name="otc"]'),
    otcError: t('#idSpan_SAOTCC_Error_OTC'),
    proofs: v('#idDiv_SAOTCS_Proofs, [data-value="PhoneAppNotification"], [data-value="PhoneAppOTP"]'),
    kmsi: v('#KmsiDescription, #KmsiCheckboxField'),
    usernameError: t('#usernameError'),
    passwordError: t('#passwordError'),
    serviceError: t('#service_exception_message'),
    passwd: v('input[name="passwd"]'),
    loginfmt: v('input[name="loginfmt"]'),
    picker: v('#tilesHolder, [data-test-id="accountList"]'),
    fido: location.pathname.includes('/bridge/fido'),
    skipButton: [...document.querySelectorAll('a, button, input[type="button"], input[type="submit"]')]
      .some((el) => vis(el) && skip.test((el.value || el.textContent || '').trim())),
  };
})()`;

/** Für Fehlermeldungen: sichtbare Elemente mit ID (Text nur bei Blättern, gekürzt). Keine Formularwerte. */
const VISIBLE_IDS_SCRIPT = `(() => {
  const vis = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.left < innerWidth && r.top < innerHeight; };
  return [...document.querySelectorAll('[id]')].filter(vis).slice(0, 40)
    .map((el) => el.id + (el.children.length === 0 && el.tagName !== 'INPUT' ? ': ' + (el.textContent || '').trim().slice(0, 60) : ''));
})()`;

const redactEmails = (s: string) => s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');

interface Detected {
  path: string;
  number: string;
  pushWaiting: boolean;
  denied: string;
  timedOut: string;
  otc: boolean;
  otcError: string;
  proofs: boolean;
  kmsi: boolean;
  usernameError: string;
  passwordError: string;
  serviceError: string;
  passwd: boolean;
  loginfmt: boolean;
  picker: boolean;
  fido: boolean;
  skipButton: boolean;
}

/** Welche Microsoft-Seite ist gerade zu sehen? */
export async function detectStep(page: Page): Promise<Step> {
  const r = (await page.evaluate(DETECT_SCRIPT)) as Detected;
  if (r.denied) return { kind: 'error', message: 'Die Anmeldung wurde in der Authenticator-App abgelehnt.' };
  if (r.timedOut) return { kind: 'error', message: 'Die Bestätigung in der Authenticator-App ist abgelaufen.' };
  if (r.usernameError) return { kind: 'error', message: `Microsoft: ${r.usernameError}` };
  if (r.passwordError) return { kind: 'error', message: `Microsoft: ${r.passwordError}` };
  if (r.serviceError) return { kind: 'error', message: `Microsoft: ${r.serviceError}` };
  if (r.fido) return { kind: 'fido' };
  if (r.number || r.pushWaiting) return { kind: 'push', ...(r.number ? { number: r.number } : {}) };
  if (r.otc) return { kind: 'otp', ...(r.otcError ? { error: r.otcError } : {}) };
  if (r.proofs) return { kind: 'proof_choice' };
  if (r.kmsi) return { kind: 'kmsi' };
  if (r.passwd) return { kind: 'password' };
  if (r.loginfmt) return { kind: 'email' };
  if (r.picker) return { kind: 'account_picker' };
  if (r.skipButton) return { kind: 'interrupt' };
  return { kind: 'unknown' };
}

async function clickFirst(page: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click({ timeout: 10_000 });
      return true;
    }
  }
  return false;
}

const SUBMIT = ['#idSIButton9', 'button[type="submit"]', 'input[type="submit"]'];

export interface EntraDeps {
  pool: BrowserPool;
  sessions: ProjoSessionManager;
  baseUrl: string;
  keepMsCookies: boolean;
}

export class EntraLoginJob {
  status: EntraJobStatus;
  result?: ConnectionStatus;
  private cancelled = false;
  private codeResolver?: (code: string) => void;
  private readonly startedMs = Date.now();

  constructor(
    readonly mcpEmail: string,
    readonly msEmail: string,
    private msPassword: string,
    private readonly deps: EntraDeps,
  ) {
    const now = new Date().toISOString();
    this.status = { state: 'starting', message: 'Anmeldung wird vorbereitet …', startedAt: now, updatedAt: now };
  }

  get finished(): boolean {
    return this.status.state === 'done' || this.status.state === 'failed';
  }

  cancel(): void {
    this.cancelled = true;
    this.codeResolver?.('');
  }

  /** Code (TOTP/SMS/E-Mail) von der Verbindungsseite übernehmen. */
  submitCode(code: string): boolean {
    if (this.status.state !== 'awaiting_code' || !this.codeResolver) return false;
    this.codeResolver(code);
    return true;
  }

  private set(state: EntraJobState, message: string, extra: Partial<EntraJobStatus> = {}): void {
    this.status = { state, message, startedAt: this.status.startedAt, updatedAt: new Date().toISOString(), ...extra };
  }

  private waitForCode(): Promise<string> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new ProjoError('projo_login_failed', 'Kein Code eingegeben – Zeitüberschreitung.')), CODE_TIMEOUT_MS);
      this.codeResolver = (code) => {
        clearTimeout(t);
        this.codeResolver = undefined;
        resolve(code);
      };
    });
  }

  private isProjo(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.deps.baseUrl).origin;
    } catch {
      return false;
    }
  }

  async run(): Promise<void> {
    let lease: Awaited<ReturnType<BrowserPool['newContext']>> | undefined;
    try {
      lease = await this.deps.pool.newContext();
      await lease.context.addInitScript(NO_WEBAUTHN_SCRIPT);
      const page = await lease.context.newPage();
      page.setDefaultTimeout(30_000);

      this.set('starting', 'projo-Anmeldeseite wird geöffnet …');
      await page.goto(`${this.deps.baseUrl}/login`, { waitUntil: 'domcontentloaded' });
      const sso = page.locator('form[action$="/auth/entra_id"] button, form[action$="/auth/entra_id"] [type="submit"]').first();
      if ((await sso.count()) === 0) throw new ProjoError('drift_detected', 'Auf der projo-Anmeldeseite fehlt „Mit Microsoft anmelden“.');
      await sso.click();
      await page.waitForURL((u) => !this.isProjo(u.toString()) || !isLoginPath(u.pathname), { timeout: 30_000 });

      this.set('microsoft', 'Anmeldung bei Microsoft läuft …');
      await this.microsoftSteps(page);

      this.set('finishing', 'Verbindung mit projo wird gespeichert …');
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      let profile: ProjoProfile = parseProfile(cheerio.load(await page.content()));
      if (!profile.userId) {
        await page.goto(`${this.deps.baseUrl}/app/dates/today`, { waitUntil: 'domcontentloaded' });
        if (isLoginPath(new URL(page.url()).pathname)) throw new ProjoError('projo_login_failed', 'projo hat die Microsoft-Anmeldung nicht übernommen.');
        profile = parseProfile(cheerio.load(await page.content()));
      }
      if (!profile.userId && !profile.name) throw new ProjoError('drift_detected', 'Nach der Microsoft-Anmeldung sieht projo unerwartet aus.');

      const state = (await lease.context.storageState()) as StorageState;
      this.result = await this.deps.sessions.connectWithStorageState(this.mcpEmail, this.msEmail, 'entra', state, profile);
      this.set('done', `Verbunden mit projo als ${profile.name ?? this.msEmail}.`);
    } catch (err) {
      const message = isProjoError(err) ? err.message : `Unerwarteter Fehler: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
      log('warn', 'Microsoft-Connect fehlgeschlagen', { user: this.mcpEmail, code: isProjoError(err) ? err.code : 'error', message });
      this.set('failed', message);
    } finally {
      this.msPassword = '';
      this.codeResolver = undefined;
      await lease?.release();
    }
  }

  private async microsoftSteps(page: Page): Promise<void> {
    let emailSent = 0;
    let passwordSent = 0;
    let codeTries = 0;
    let fidoTries = 0;
    let unknown = 0;
    let lastStep = '';
    const deadline = this.startedMs + JOB_TIMEOUT_MS;

    while (true) {
      if (this.cancelled) throw new ProjoError('projo_login_failed', 'Anmeldung abgebrochen.');
      if (Date.now() > deadline) throw new ProjoError('projo_login_failed', 'Zeitüberschreitung bei der Microsoft-Anmeldung.');
      const url = page.url();

      if (this.isProjo(url)) {
        if (!isLoginPath(new URL(url).pathname)) return; // geschafft
        const flash = cleanText(await page.locator('.alert, #flash_container_for_bip').first().textContent().catch(() => ''));
        throw new ProjoError('projo_login_failed', flash || 'projo hat die Microsoft-Anmeldung abgelehnt (ist das Konto in projo für SSO freigeschaltet?).');
      }
      if (!MS_HOST.test(url)) {
        // Zwischenstationen (z. B. Föderation/ADFS) – kurz warten, dann aufgeben
        if (++unknown > 40) throw new ProjoError('projo_login_failed', `Unerwartete Anmeldeseite: ${new URL(url).host}`);
        await sleep(500);
        continue;
      }

      let detectError: string | undefined;
      const step = await detectStep(page).catch((err: unknown): Step => {
        detectError = err instanceof Error ? err.message.split('\n')[0] : String(err);
        return { kind: 'unknown' };
      });
      if (step.kind !== 'unknown') unknown = 0;
      if (step.kind !== lastStep) {
        log('info', 'Microsoft-Schritt', { user: this.mcpEmail, step: step.kind, path: new URL(url).pathname, ...(detectError ? { detectError } : {}) });
        lastStep = step.kind;
      }

      switch (step.kind) {
        case 'error':
          throw new ProjoError('projo_login_failed', step.message);

        case 'email':
          if (++emailSent > 3) throw new ProjoError('projo_login_failed', 'Microsoft hat die E-Mail-Adresse nicht angenommen.');
          await page.locator('input[name="loginfmt"]').first().fill(this.msEmail);
          await clickFirst(page, SUBMIT);
          break;

        case 'account_picker': {
          const tile = page.locator(`[data-test-id="${this.msEmail}"], div[role="listitem"]:has-text("${this.msEmail}"), .table:has-text("${this.msEmail}")`).first();
          if (await tile.isVisible().catch(() => false)) await tile.click();
          else if (!(await clickFirst(page, ['#otherTile', '[data-test-id="otherTile"]']))) throw new ProjoError('projo_login_failed', 'Microsoft-Kontoauswahl konnte nicht bedient werden.');
          break;
        }

        case 'password':
          if (!this.msPassword) throw new ProjoError('projo_login_failed', 'Microsoft fragt nach dem Passwort – bitte auf der Verbindungsseite mit angeben.');
          if (++passwordSent > 2) throw new ProjoError('projo_login_failed', 'Microsoft hat das Passwort nicht angenommen.');
          await page.locator('input[name="passwd"]').first().fill(this.msPassword);
          await clickFirst(page, SUBMIT);
          break;

        case 'push': {
          this.set(
            'awaiting_approval',
            step.number ? 'Bitte in der Microsoft-Authenticator-App bestätigen und diese Zahl eingeben:' : 'Bitte die Anmeldung in der Microsoft-Authenticator-App bestätigen.',
            step.number ? { number: step.number } : {},
          );
          const until = Date.now() + APPROVAL_TIMEOUT_MS;
          let next: Step = step;
          while (next.kind === 'push' && Date.now() < until && !this.cancelled) {
            await sleep(1000);
            if (!MS_HOST.test(page.url())) break;
            next = await detectStep(page).catch((): Step => ({ kind: 'unknown' }));
          }
          if (next.kind === 'push') throw new ProjoError('projo_login_failed', 'Keine Bestätigung in der Authenticator-App erhalten.');
          this.set('microsoft', 'Bestätigt – Anmeldung wird abgeschlossen …');
          break;
        }

        case 'otp': {
          if (++codeTries > 3) throw new ProjoError('projo_login_failed', 'Der Code wurde mehrfach nicht akzeptiert.');
          this.set('awaiting_code', step.error ? `Microsoft: ${step.error} – bitte den Code erneut eingeben.` : 'Bitte den Bestätigungscode eingeben (Authenticator-App, SMS oder E-Mail).');
          const code = (await this.waitForCode()).replace(/\s+/g, '');
          if (this.cancelled) throw new ProjoError('projo_login_failed', 'Anmeldung abgebrochen.');
          this.set('microsoft', 'Code wird geprüft …');
          await page.locator('input[name="otc"]').first().fill(code);
          await clickFirst(page, ['#idSubmit_SAOTCC_Continue', ...SUBMIT]);
          break;
        }

        case 'fido':
          // Passkey-Seite trotz ausgeblendetem WebAuthn → einmal zurück, sonst klare Meldung
          if (++fidoTries > 1 || !(await clickFirst(page, ['#idBtn_Back']))) {
            throw new ProjoError('projo_login_failed', 'Microsoft verlangt für dieses Konto einen Passkey (Gesichtserkennung/Fingerabdruck/Sicherheitsschlüssel) – das kann der Server nicht. Bitte Authenticator-App oder Passwort als Anmeldemethode erlauben.');
          }
          break;

        case 'proof_choice':
          if (!(await clickFirst(page, ['[data-value="PhoneAppNotification"]', '[data-value="PhoneAppOTP"]', '[data-value="OneWaySMS"]', '#idDiv_SAOTCS_Proofs [role="button"]']))) {
            throw new ProjoError('projo_login_failed', 'Microsoft verlangt eine Bestätigungsmethode, die nicht gewählt werden konnte.');
          }
          break;

        case 'kmsi':
          // „Angemeldet bleiben?“ – nur sinnvoll, wenn Microsoft-Cookies für eine stille Neuanmeldung behalten werden
          await clickFirst(page, this.deps.keepMsCookies ? ['#idSIButton9'] : ['#idBtn_Back', '#idSIButton9']);
          break;

        case 'interrupt': {
          const skip = page.locator('a, button, input[type="button"], input[type="submit"]').filter({ hasText: SKIP_TEXT });
          if (await skip.first().isVisible().catch(() => false)) await skip.first().click();
          else await clickFirst(page, ['#btnAskLater']);
          break;
        }

        case 'unknown':
          if (++unknown > 40) {
            const ids = (await page.evaluate(VISIBLE_IDS_SCRIPT).catch(() => [])) as string[];
            log('warn', 'Microsoft: unbekannte Seite', { user: this.mcpEmail, path: new URL(page.url()).pathname, title: await page.title().catch(() => ''), visible: ids.map(redactEmails), detectError });
            throw new ProjoError('projo_login_failed', `Unerwartete Microsoft-Seite („${cleanText(await page.title().catch(() => ''))}“).`);
          }
          await sleep(500);
          continue;
      }
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      await sleep(800);
    }
  }
}

/** Laufende Microsoft-Anmeldungen je Person (höchstens eine). */
export class EntraConnectJobs {
  private readonly jobs = new Map<string, EntraLoginJob>();

  constructor(private readonly deps: EntraDeps & { onFinish?: (job: EntraLoginJob) => void }) {}

  start(mcpEmail: string, msEmail: string, msPassword: string): EntraJobStatus {
    const key = mcpEmail.toLowerCase();
    this.jobs.get(key)?.cancel();
    const job = new EntraLoginJob(key, msEmail.trim(), msPassword, this.deps);
    this.jobs.set(key, job);
    void job.run().finally(() => this.deps.onFinish?.(job));
    return job.status;
  }

  status(mcpEmail: string): EntraJobStatus | undefined {
    const job = this.jobs.get(mcpEmail.toLowerCase());
    if (!job) return undefined;
    if (job.finished && Date.now() - Date.parse(job.status.updatedAt) > 10 * 60_000) {
      this.jobs.delete(mcpEmail.toLowerCase());
      return undefined;
    }
    return job.status;
  }

  submitCode(mcpEmail: string, code: string): boolean {
    return this.jobs.get(mcpEmail.toLowerCase())?.submitCode(code) ?? false;
  }

  cancel(mcpEmail: string): void {
    this.jobs.get(mcpEmail.toLowerCase())?.cancel();
  }

  shutdown(): void {
    for (const job of this.jobs.values()) job.cancel();
  }
}

/**
 * Stille Neuanmeldung über gespeicherte Microsoft-Cookies (nur mit PROJO_KEEP_MS_COOKIES=true):
 * „Mit Microsoft anmelden“ klicken und hoffen, dass Microsoft ohne Rückfrage zurückleitet.
 */
export async function silentSsoLogin(deps: { pool: BrowserPool; baseUrl: string }, record: VaultRecord): Promise<VaultRecord | undefined> {
  if (!record.storageState.cookies.some((c) => /microsoftonline\.com|live\.com/.test(c.domain))) return undefined;
  const lease = await deps.pool.newContext({ storageState: record.storageState });
  try {
    await lease.context.addInitScript(NO_WEBAUTHN_SCRIPT);
    const page = await lease.context.newPage();
    await page.goto(`${deps.baseUrl}/login`, { waitUntil: 'domcontentloaded' });
    await page.locator('form[action$="/auth/entra_id"] button, form[action$="/auth/entra_id"] [type="submit"]').first().click();
    const origin = new URL(deps.baseUrl).origin;
    await page.waitForURL((u) => u.origin === origin && !isLoginPath(u.pathname), { timeout: 20_000 });
    const profile = parseProfile(cheerio.load(await page.content()));
    const next: VaultRecord = {
      ...record,
      storageState: (await lease.context.storageState()) as StorageState,
      lastValidatedAt: new Date().toISOString(),
      ...(profile.name ? { projoUserName: profile.name } : {}),
      ...(profile.userId ? { projoUserId: profile.userId } : {}),
    };
    delete next.sessionExpiredAt;
    log('info', 'projo: stille Microsoft-Neuanmeldung erfolgreich', { user: record.mcpEmail });
    return next;
  } catch {
    return undefined;
  } finally {
    await lease.release();
  }
}
