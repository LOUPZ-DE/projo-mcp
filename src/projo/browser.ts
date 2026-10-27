import { chromium, type Browser, type BrowserContext, type BrowserContextOptions } from 'playwright';
import { log } from '../util/log.js';
import { ProjoError } from './errors.js';

/**
 * Ein gemeinsames headless Chromium für alle Nutzer – nur für den Microsoft-Login (und Training).
 * Normale Tool-Aufrufe laufen per HTTP. Start bei Bedarf, begrenzte Zahl gleichzeitiger Kontexte,
 * automatisches Schließen im Leerlauf, Neustart nach Absturz.
 */
export class BrowserPool {
  private browser?: Browser;
  private launching?: Promise<Browser>;
  private active = 0;
  private idleTimer?: NodeJS.Timeout;

  constructor(private readonly opts: { maxContexts: number; idleMs: number }) {}

  get activeContexts(): number {
    return this.active;
  }

  async newContext(options: BrowserContextOptions = {}): Promise<{ context: BrowserContext; release: () => Promise<void> }> {
    if (this.active >= this.opts.maxContexts) {
      throw new ProjoError('projo_unavailable', 'Gerade laufen zu viele Browser-Anmeldungen gleichzeitig – bitte in einer Minute erneut versuchen.');
    }
    this.active++;
    clearTimeout(this.idleTimer);
    try {
      const browser = await this.ensureBrowser();
      const major = browser.version().split('.')[0] ?? '140';
      const context = await browser.newContext({
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
        viewport: { width: 1280, height: 900 },
        // Headless-Shell meldet sich sonst als „HeadlessChrome“ – Microsoft behandelt das misstrauischer
        userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
        ...options,
      });
      let released = false;
      return {
        context,
        release: async () => {
          if (released) return;
          released = true;
          await context.close().catch(() => undefined);
          this.active--;
          this.scheduleIdleClose();
        },
      };
    } catch (err) {
      this.active--;
      this.scheduleIdleClose();
      throw err instanceof ProjoError ? err : new ProjoError('projo_unavailable', `Browser konnte nicht gestartet werden: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async close(): Promise<void> {
    clearTimeout(this.idleTimer);
    const b = this.browser;
    this.browser = undefined;
    await b?.close().catch(() => undefined);
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.launching ??= chromium
      .launch({ headless: true })
      .then((b) => {
        this.browser = b;
        b.on('disconnected', () => {
          if (this.browser === b) this.browser = undefined;
        });
        log('info', 'Browser gestartet', { version: b.version() });
        return b;
      })
      .finally(() => {
        this.launching = undefined;
      });
    return this.launching;
  }

  private scheduleIdleClose(): void {
    if (this.active > 0) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.active === 0 && this.browser) {
        log('info', 'Browser im Leerlauf geschlossen');
        void this.close();
      }
    }, this.opts.idleMs);
    this.idleTimer.unref();
  }
}
