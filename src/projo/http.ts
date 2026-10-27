import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { request, type APIRequestContext, type APIResponse } from 'playwright';
import { ProjoError, SessionExpiredError } from './errors.js';
import { extractHtmlFromJs, toInternalPath } from './util/dom.js';
import type { StorageState } from './vault.js';

/**
 * HTTP-Treiber (Standardweg): Playwright-APIRequestContext mit dem storageState des Nutzers.
 * Kein Browserprozess – nur Requests mit denselben Cookies, die auch ein Browser-Login erzeugt.
 *
 * Grundsätze:
 * - `maxRedirects: 0` → ein Redirect auf /login ist immer als abgelaufene Sitzung erkennbar.
 * - Nur Requests auf den Projo-Host (absolute Fremd-URLs werden abgewiesen).
 * - Kleiner Mindestabstand zwischen Requests, Projo soll nicht geflutet werden.
 */

export interface ProjoResponse {
  status: number;
  /** angefragter Pfad (+ Query) */
  path: string;
  /** Location-Header bei 3xx, als interner Pfad, wenn same-origin */
  location?: string;
  contentType: string;
  body: string;
}

export interface ProjoPage extends ProjoResponse {
  /** Pfad nach allen Redirects */
  finalPath: string;
  /** HTML (bei JS-Antworten von rails-ujs: das eingebettete HTML) */
  html: string;
  $: CheerioAPI;
}

export interface HttpOptions {
  baseUrl: string;
  storageState?: StorageState;
  userAgent?: string;
  timeoutMs?: number;
  /** Mindestabstand zwischen zwei Requests (ms) */
  minIntervalMs?: number;
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface SendOptions {
  form?: [string, string][];
  headers?: Record<string, string>;
  /** rails-ujs nachbilden (X-Requested-With, Accept: JavaScript) */
  xhr?: boolean;
  accept?: string;
  /** X-CSRF-Token-Header (für best_in_place/XHR-Writes) */
  csrfToken?: string;
}

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 projo-mcp/0.1';

const ACCEPT_HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const ACCEPT_JS = 'text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01';

export const isRedirect = (status: number): boolean => status >= 300 && status < 400;

export function isLoginPath(path: string | undefined): boolean {
  if (!path) return false;
  const p = path.replace(/^https?:\/\/[^/]+/, '');
  return /^\/login(\?|$|\/)/.test(p);
}

/** Erkennt die ausgelieferte Projo-Login-Seite (falls Projo nicht umleitet, sondern direkt rendert). */
export function looksLikeLoginPage($: CheerioAPI): boolean {
  return $('form[action$="/login"] input[name="session[password]"]').length > 0;
}

export function csrfFromPage($: CheerioAPI): string | undefined {
  return $('meta[name="csrf-token"]').attr('content') ?? $('input[name="authenticity_token"]').first().attr('value');
}

/**
 * XHR-Antworten leiten nicht per 302 um, sondern per JavaScript: `Turbo.visit("…/login")`.
 * So reagiert projo auf eine abgelaufene Sitzung – und auf ein abgelehntes CSRF-Token.
 */
export function isJsLoginRedirect(res: { contentType: string; body: string }): boolean {
  return /javascript/i.test(res.contentType) && /(Turbo\.visit|location(\.href)?\s*=)\s*\(?\s*["'][^"']*\/login["'?]/.test(res.body.slice(0, 2000));
}

export class ProjoHttp {
  private lastRequestAt = 0;

  private constructor(
    private readonly ctx: APIRequestContext,
    readonly baseUrl: string,
    private readonly minIntervalMs: number,
  ) {}

  static async create(opts: HttpOptions): Promise<ProjoHttp> {
    const baseUrl = opts.baseUrl.replace(/\/+$/, '');
    const ctx = await request.newContext({
      baseURL: baseUrl,
      storageState: opts.storageState,
      userAgent: opts.userAgent ?? DEFAULT_USER_AGENT,
      extraHTTPHeaders: { 'Accept-Language': 'de-DE,de;q=0.9,en;q=0.5' },
      timeout: opts.timeoutMs ?? 15_000,
      maxRedirects: 0,
    });
    return new ProjoHttp(ctx, baseUrl, opts.minIntervalMs ?? 150);
  }

  /**
   * GET einer Seite inkl. Redirect-Verfolgung (same-origin, max. 5 Hops).
   * Redirect auf /login bzw. ausgelieferte Login-Seite → SessionExpiredError.
   */
  async getPage(path: string, opts: { headers?: Record<string, string>; xhr?: boolean; allowLoginPage?: boolean } = {}): Promise<ProjoPage> {
    let current = path;
    for (let hop = 0; hop <= 5; hop++) {
      const res = await this.request('GET', current, { headers: opts.headers, xhr: opts.xhr });
      if (isRedirect(res.status)) {
        if (!res.location) throw new ProjoError('projo_unavailable', `Redirect ohne Ziel von ${current}`);
        if (isLoginPath(res.location) && !opts.allowLoginPage) throw new SessionExpiredError();
        if (/^https?:/i.test(res.location)) throw new ProjoError('blocked', `Redirect auf fremden Host (${res.location})`);
        current = res.location;
        continue;
      }
      this.assertStatus(res, current);
      if (!opts.allowLoginPage && isJsLoginRedirect(res)) throw new SessionExpiredError();
      const html = /javascript/i.test(res.contentType) ? extractHtmlFromJs(res.body) : res.body;
      const $ = cheerio.load(html);
      if (!opts.allowLoginPage && looksLikeLoginPage($)) throw new SessionExpiredError();
      return { ...res, finalPath: current, html, $ };
    }
    throw new ProjoError('projo_unavailable', `Zu viele Redirects ab ${path}`);
  }

  /** Einzelner Request ohne Redirect-Verfolgung (für Writes/XHR) – Aufrufer wertet Status und Location aus. */
  async send(method: HttpMethod, path: string, opts: SendOptions = {}): Promise<ProjoResponse> {
    const res = await this.request(method, path, opts);
    if (isRedirect(res.status) && isLoginPath(res.location)) throw new SessionExpiredError();
    if (res.status === 401 || isJsLoginRedirect(res)) throw new SessionExpiredError();
    return res;
  }

  async storageState(): Promise<StorageState> {
    return (await this.ctx.storageState()) as StorageState;
  }

  async dispose(): Promise<void> {
    await this.ctx.dispose().catch(() => undefined);
  }

  private assertStatus(res: ProjoResponse, path: string): void {
    if (res.status === 401) throw new SessionExpiredError();
    if (res.status === 403) throw new ProjoError('projo_forbidden', `Projo verweigert den Zugriff auf ${path}.`);
    if (res.status === 404) throw new ProjoError('not_found', `Die Projo-Seite ${path} existiert nicht.`);
    if (res.status >= 500) throw new ProjoError('projo_unavailable', `Projo antwortet mit HTTP ${res.status}.`);
    if (res.status >= 400) throw new ProjoError('projo_unavailable', `Unerwartete Antwort HTTP ${res.status} für ${path}.`);
  }

  private resolve(path: string): string {
    if (/^https?:\/\//i.test(path)) {
      const url = new URL(path);
      if (url.origin !== new URL(this.baseUrl).origin) throw new ProjoError('blocked', `Nur Requests an ${this.baseUrl} sind erlaubt.`);
      return url.toString();
    }
    if (!path.startsWith('/')) throw new ProjoError('invalid_input', `Pfad muss mit / beginnen: ${path}`);
    return `${this.baseUrl}${path}`;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }

  private async request(method: HttpMethod, path: string, opts: SendOptions): Promise<ProjoResponse> {
    const url = this.resolve(path);
    await this.throttle();
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    headers['Accept'] ??= opts.accept ?? (opts.xhr ? ACCEPT_JS : ACCEPT_HTML);
    if (opts.xhr) headers['X-Requested-With'] = 'XMLHttpRequest';
    if (opts.csrfToken) headers['X-CSRF-Token'] = opts.csrfToken;
    let data: string | undefined;
    if (opts.form) {
      data = new URLSearchParams(opts.form).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    }
    let res: APIResponse;
    try {
      res = await this.ctx.fetch(url, { method, headers, data, maxRedirects: 0, failOnStatusCode: false });
    } catch (err) {
      throw new ProjoError('projo_unavailable', `Projo ist nicht erreichbar: ${err instanceof Error ? err.message : String(err)}`);
    }
    const location = res.headers()['location'];
    return {
      status: res.status(),
      path: toInternalPath(url, this.baseUrl) ?? path,
      ...(location ? { location: toInternalPath(location, this.baseUrl) ?? location } : {}),
      contentType: res.headers()['content-type'] ?? '',
      body: await res.text(),
    };
  }
}
