import { existsSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectStep } from '../src/projo/auth/entra.js';

/**
 * Schritterkennung des Microsoft-Logins gegen nachgebaute Seiten (Struktur wie login.microsoftonline.com,
 * Stand 2026-10). Läuft in echtem Chromium – wird übersprungen, wenn Playwrights Chromium nicht installiert ist.
 */
const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

describe.skipIf(!hasChromium)('Microsoft-Schritterkennung', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  const show = (html: string) => page.setContent(`<style>.moveOffScreen{position:fixed;left:-10000px;top:-10000px}</style>${html}`);

  it('E-Mail-Seite (Passwortfeld liegt unsichtbar außerhalb des Bildschirms)', async () => {
    await show(`<div id="loginHeader">Anmelden</div>
      <input type="email" name="loginfmt" id="i0116"><input type="password" name="passwd" id="i0118" class="moveOffScreen">
      <input type="submit" id="idSIButton9" value="Weiter">`);
    expect(await detectStep(page)).toEqual({ kind: 'email' });
  });

  it('kennwortlose Genehmigung mit Zahl', async () => {
    await show(`<div id="loginHeader">Anmeldung genehmigen</div>
      <div id="idDiv_RemoteNGC_PollingDescription">Öffnen Sie Ihre Authenticator-App …</div><div id="idRemoteNGC_DisplaySign">31</div>`);
    expect(await detectStep(page)).toEqual({ kind: 'push', number: '31' });
  });

  it('Push nach Passwort (Number Matching)', async () => {
    await show(`<div id="idDiv_SAOTCAS_Description">Genehmigen Sie die Anmeldeanforderung</div><div id="idRichContext_DisplaySign">57</div>`);
    expect(await detectStep(page)).toEqual({ kind: 'push', number: '57' });
  });

  it('Code-Eingabe inkl. Fehlermeldung', async () => {
    await show(`<input name="otc" id="idTxtBx_SAOTCC_OTC"><span id="idSpan_SAOTCC_Error_OTC">Code falsch</span>`);
    expect(await detectStep(page)).toEqual({ kind: 'otp', error: 'Code falsch' });
  });

  it('„Angemeldet bleiben?“', async () => {
    await show(`<div id="KmsiDescription">Angemeldet bleiben?</div><input type="submit" id="idSIButton9" value="Ja"><input type="button" id="idBtn_Back" value="Nein">`);
    expect(await detectStep(page)).toEqual({ kind: 'kmsi' });
  });

  it('Passwortseite und Passwortfehler', async () => {
    await show(`<input type="password" name="passwd" id="i0118">`);
    expect(await detectStep(page)).toEqual({ kind: 'password' });
    await show(`<div id="passwordError">Ihr Kennwort ist falsch.</div><input type="password" name="passwd">`);
    expect(await detectStep(page)).toEqual({ kind: 'error', message: 'Microsoft: Ihr Kennwort ist falsch.' });
  });

  it('Zwischenseite mit „Überspringen“ (z. B. Passkey-Hinweis)', async () => {
    await show(`<h1>Passkey erstellen</h1><a href="#">Überspringen</a>`);
    expect(await detectStep(page)).toEqual({ kind: 'interrupt' });
  });

  it('unbekannte Seite', async () => {
    await show(`<h1>Etwas ganz anderes</h1>`);
    expect(await detectStep(page)).toEqual({ kind: 'unknown' });
  });
});
