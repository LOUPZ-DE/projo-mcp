import * as cheerio from 'cheerio';
import { ProjoError } from '../errors.js';
import { extractForm, parseFormErrors, serializeForm } from '../form.js';
import { isLoginPath, isRedirect, ProjoHttp } from '../http.js';
import { parseProfile, type ProjoProfile } from '../pages/profile.js';
import { cleanText } from '../util/dom.js';
import type { StorageState } from '../vault.js';

export interface PasswordLoginResult {
  storageState: StorageState;
  profile: ProjoProfile;
}

/**
 * projo-eigener Login (E-Mail + Passwort) – reines HTTP, kein Browser:
 * GET /login → Formular mit frischem authenticity_token → POST /login → Redirect in die App.
 */
export async function passwordLogin(opts: {
  baseUrl: string;
  userAgent?: string;
  email: string;
  password: string;
}): Promise<PasswordLoginResult> {
  const http = await ProjoHttp.create({ baseUrl: opts.baseUrl, userAgent: opts.userAgent });
  try {
    const loginPage = await http.getPage('/login', { allowLoginPage: true });
    const form = extractForm(loginPage.$, 'form[action$="/login"]', http.baseUrl);
    const fields = serializeForm(form, { 'session[email]': opts.email, 'session[password]': opts.password });
    const res = await http.send('POST', form.action, { form: fields }).catch((err: unknown) => {
      // send() wertet Redirect → /login als abgelaufene Sitzung; hier heißt das: Login abgelehnt
      if (err instanceof ProjoError && err.code === 'projo_login_required') return undefined;
      throw err;
    });

    if (!res || !isRedirect(res.status) || !res.location || isLoginPath(res.location)) {
      // Fehlversuch: projo rendert die Login-Seite erneut (oder leitet auf /login um) – Flash auslesen
      const page = res && !isRedirect(res.status) ? res.body : (await http.getPage('/login', { allowLoginPage: true })).html;
      const $ = cheerio.load(page);
      const reasons = [...parseFormErrors($), ...$('.alert, #flash_container_for_bip').toArray().map((e) => cleanText($(e).text()))].filter(Boolean);
      throw new ProjoError('projo_login_failed', reasons[0] ?? 'projo hat die Anmeldung abgelehnt (E-Mail/Passwort prüfen – ist für das Konto evtl. nur „Mit Microsoft anmelden“ erlaubt?).');
    }

    const landing = await http.getPage(res.location);
    const profile = parseProfile(landing.$);
    if (!profile.userId && !profile.name) {
      throw new ProjoError('drift_detected', 'Anmeldung scheinbar erfolgreich, aber die projo-Startseite sieht unerwartet aus.');
    }
    return { storageState: await http.storageState(), profile };
  } finally {
    await http.dispose();
  }
}
