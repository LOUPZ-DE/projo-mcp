import { config } from '../config.js';
import type { EntraJobStatus } from '../projo/auth/entra.js';
import type { ConnectionStatus } from '../projo/session.js';
import { escapeHtml, widePage } from '../util/html.js';

/**
 * Server-gerenderte Seiten der Verbindungsseite (/connect) – bewusst ohne Client-Framework.
 * Grundsatz: eine Hauptaktion, alles Optionale eingeklappt (<details>), funktioniert auch ohne JavaScript.
 */

const EXTRA_CSS = `
<style>
  .status { border-radius: 8px; padding: .75rem 1rem; margin: 1rem 0; font-size: .9rem; line-height: 1.45; }
  .status.ok { background: #064e3b; color: #a7f3d0; }
  .status.warn { background: #78350f; color: #fde68a; }
  .status.none { background: #334155; color: #e2e8f0; }
  .notice { background: #0c4a6e; color: #bae6fd; border-radius: 8px; padding: .5rem .75rem; font-size: .85rem; margin-top: 1rem; }
  .step { display: inline-block; font-size: .75rem; color: #7dd3fc; text-transform: uppercase; letter-spacing: .06em; margin-bottom: .25rem; }
  .hint { font-size: .8rem; color: #94a3b8; margin-top: .6rem; line-height: 1.4; }
  details { margin-top: 1rem; }
  summary { cursor: pointer; color: #7dd3fc; font-size: .85rem; }
  details[open] > summary { margin-bottom: .25rem; }
  .check { display: flex; gap: .5rem; align-items: flex-start; margin-top: .9rem; font-size: .8rem; color: #94a3b8; }
  .check input { width: auto; margin-top: .15rem; }
  .secondary { background: #334155; color: #e2e8f0; }
  .secondary:hover { background: #475569; }
  .linklike { background: none; color: #94a3b8; font-weight: 400; font-size: .85rem; text-decoration: underline; padding: .25rem; margin-top: .75rem; }
  .linklike:hover { background: none; color: #fecaca; }
  .skip { display: block; text-align: center; margin-top: 1.25rem; font-size: .85rem; color: #94a3b8; }
  .mfa-number { font-size: 2.5rem; font-weight: 700; text-align: center; letter-spacing: .1em; margin: .5rem 0; }
</style>`;

function render(title: string, body: string, extraHead = ''): string {
  return widePage(title, body).replace('</head>', `${EXTRA_CSS}${extraHead}</head>`);
}

const MESSAGES: Record<string, { cls: 'ok' | 'notice'; text: string }> = {
  connected: { cls: 'ok', text: 'projo-Konto verbunden – dieses Fenster schließt sich gleich, danach im Chat weitermachen.' },
  disconnected: { cls: 'notice', text: 'Die Verbindung zu projo wurde getrennt.' },
};

function fmt(iso?: string): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', dateStyle: 'medium', timeStyle: 'short' });
}

export interface ConnectPageOpts {
  email: string;
  status: ConnectionStatus;
  csrf: string;
  msg?: string;
  error?: string;
  allowStorePassword: boolean;
  microsoftAvailable: boolean;
  /** laufende oder gerade beendete Microsoft-Anmeldung */
  msJob?: EntraJobStatus;
  /** Verbinden im Connector-Ablauf („Schritt 2 von 2“, danach zurück zum Client) */
  flow?: { id: string; clientName?: string };
}

export const ACTIVE_MS_STATES = new Set(['starting', 'microsoft', 'awaiting_approval', 'awaiting_code', 'finishing']);

/**
 * Absenden ohne Verlaufseintrag nur außerhalb des Connector-Ablaufs: dort endet die Weiterleitungskette beim
 * Client (fremde Domain) – fetch scheitert an CORS und würde das Formular doppelt absenden.
 */
const inplace = (o: { flow?: unknown }) => (o.flow ? '' : ' data-inplace');

const hidden = (name: string, value: string | undefined) => (value ? `<input type="hidden" name="${name}" value="${escapeHtml(value)}">` : '');

/**
 * Live-Status der Microsoft-Anmeldung. Funktioniert auch ohne JavaScript: Solange die Anmeldung läuft,
 * lädt sich die Seite per <meta refresh> neu (Zahl serverseitig gerendert). Das Script beschleunigt nur,
 * löscht nie Inhalte und lädt bei Abschluss neu (im Connector-Ablauf geht es dann zurück zum Client).
 */
function msJobBox(job: EntraJobStatus, csrf: string, flowId?: string): string {
  const back = flowId ? `/connect?flow=${encodeURIComponent(flowId)}` : '/connect';
  return `
    <div id="ms-job" class="status none" data-state="${escapeHtml(job.state)}" data-back="${escapeHtml(back)}">
      <div id="ms-msg">${escapeHtml(job.message)}</div>
      <div id="ms-number" class="mfa-number"${job.number ? '' : ' hidden'}>${escapeHtml(job.number ?? '')}</div>
      <form id="ms-code" method="post" action="/connect/mfa"${job.state === 'awaiting_code' ? '' : ' hidden'}>
        ${hidden('csrf', csrf)}
        <label for="ms_code">Bestätigungscode</label>
        <input id="ms_code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
        <button type="submit">Code senden</button>
      </form>
      <div class="hint">Aktualisiert sich automatisch – falls sich nichts tut, die Seite neu laden.</div>
      <form id="ms-cancel" method="post" action="/connect/microsoft/cancel"${flowId ? '' : ' data-inplace'}>
        ${hidden('csrf', csrf)}${hidden('flow', flowId)}
        <button type="submit" class="linklike">Abbrechen</button>
      </form>
    </div>
    <script>
    (() => {
      const box = document.getElementById('ms-job');
      if (!box) return;
      const msg = document.getElementById('ms-msg');
      const num = document.getElementById('ms-number');
      const codeForm = document.getElementById('ms-code');
      const back = box.dataset.back;
      let state = box.dataset.state;
      let timer;
      const apply = (s) => {
        if (!s || !s.state || s.state === 'none') return;
        if (s.state === 'done' || s.state === 'failed') {
          clearInterval(timer);
          location.replace(s.state === 'done' && back === '/connect' ? '/connect?msg=connected' : back);
          return;
        }
        if (s.message) msg.textContent = s.message;
        if (s.number) { num.textContent = s.number; num.hidden = false; }
        else if (s.state !== 'awaiting_approval') num.hidden = true;
        if (s.state === 'awaiting_code' && state !== 'awaiting_code') { codeForm.hidden = false; codeForm.querySelector('input[name=code]').focus(); }
        if (s.state !== 'awaiting_code') codeForm.hidden = true;
        state = s.state;
      };
      const poll = () => fetch('/connect/status', { cache: 'no-store', credentials: 'same-origin' }).then((r) => r.json()).then(apply).catch(() => {});
      codeForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const data = new URLSearchParams(new FormData(codeForm));
        codeForm.hidden = true;
        msg.textContent = 'Code wird geprüft …';
        fetch('/connect/mfa', { method: 'POST', credentials: 'same-origin', body: data }).finally(poll);
        codeForm.reset();
      });
      timer = setInterval(poll, 1500);
      poll();
    })();
    </script>`;
}

/**
 * Formulare mit data-inplace ohne neuen Verlaufseintrag absenden (fetch + location.replace) – so bleibt ein
 * vom Chat-Link geöffnetes Fenster per Script schließbar (Browser erlauben window.close() nur bei einem
 * Verlaufseintrag). Ohne JavaScript greift das normale Absenden. Nach erfolgreicher Verbindung: Fenster schließen.
 */
const PAGE_SCRIPT = `<script>
(() => {
  for (const form of document.querySelectorAll('form[data-inplace]')) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const button = form.querySelector('button[type=submit]');
      if (button) button.disabled = true;
      try {
        const res = await fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)), credentials: 'same-origin' });
        if (res.redirected) { location.replace(res.url); return; }
        const html = await res.text();
        history.replaceState(null, '', location.pathname + location.search);
        document.open(); document.write(html); document.close();
      } catch (err) {
        form.submit();
      }
    });
  }
  const hint = document.getElementById('close-hint');
  if (hint) {
    setTimeout(() => {
      window.close();
      setTimeout(() => { hint.textContent = 'projo-Konto verbunden. Du kannst dieses Fenster jetzt schließen und im Chat weitermachen.'; }, 500);
    }, 2000);
  }
})();
</script>`;

/** Hauptaktion „Mit Microsoft verbinden“: nur das Konto-Feld, Passwort eingeklappt. */
function microsoftForm(o: ConnectPageOpts, email: string, cta: string): string {
  return `
    <form method="post" action="/connect/microsoft" accept-charset="utf-8" autocomplete="off"${inplace(o)}>
      ${hidden('csrf', o.csrf)}${hidden('flow', o.flow?.id)}
      <label for="ms_email">Microsoft-Konto</label>
      <input id="ms_email" name="ms_email" type="email" required value="${escapeHtml(email)}" autocomplete="username">
      <details>
        <summary>Microsoft fragt nach einem Passwort?</summary>
        <label for="ms_password">Microsoft-Passwort (wird nicht gespeichert)</label>
        <input id="ms_password" name="ms_password" type="password" autocomplete="current-password">
      </details>
      <button type="submit">${cta}</button>
    </form>
    <div class="hint">Anschließend erscheint hier eine Zahl, die du in der Microsoft-Authenticator-App bestätigst.</div>`;
}

/** projo-eigenes Login (E-Mail + Passwort). */
function passwordForm(o: ConnectPageOpts, email: string, cta: string): string {
  return `
    <form method="post" action="/connect/password" accept-charset="utf-8" autocomplete="off"${inplace(o)}>
      ${hidden('csrf', o.csrf)}${hidden('flow', o.flow?.id)}
      <label for="projo_email">projo-E-Mail</label>
      <input id="projo_email" name="projo_email" type="email" required value="${escapeHtml(email)}" autocomplete="username">
      <label for="projo_password">projo-Passwort</label>
      <input id="projo_password" name="projo_password" type="password" required autocomplete="current-password">
      ${o.allowStorePassword ? `<label class="check"><input type="checkbox" name="store_password" value="1">
        <span>Passwort verschlüsselt speichern – dann meldet sich der Server bei abgelaufener Sitzung selbst neu an.</span></label>` : ''}
      <button type="submit">${cta}</button>
    </form>`;
}

/** Verbindungsformulare: eine Hauptmethode sichtbar, die andere eingeklappt. */
function connectForms(o: ConnectPageOpts): string {
  const email = o.status.projoEmail ?? o.email;
  const preferPassword = o.status.method === 'password' || !o.microsoftAvailable;
  if (preferPassword) {
    return `${passwordForm(o, email, 'Mit projo verbinden')}
      ${o.microsoftAvailable ? `<details><summary>Stattdessen „Mit Microsoft anmelden“ verwenden</summary>${microsoftForm(o, email, 'Mit Microsoft verbinden')}</details>` : ''}`;
  }
  return `${microsoftForm(o, email, 'Mit Microsoft verbinden')}
    <details><summary>Stattdessen mit projo-E-Mail und Passwort verbinden</summary>${passwordForm(o, email, 'Mit projo verbinden')}</details>`;
}

function connectedBox(s: ConnectionStatus): string {
  const who = escapeHtml(s.projoUserName ? `${s.projoUserName} (${s.projoEmail})` : (s.projoEmail ?? ''));
  const method = s.method === 'entra' ? 'Microsoft' : 'projo-Passwort';
  return `<div class="status ok">Verbunden mit projo als <b>${who}</b><br>
    <span style="font-size:.8rem">Anmeldung: ${method} · seit ${fmt(s.connectedAt)} · zuletzt geprüft ${fmt(s.lastValidatedAt)}${
      s.method === 'password' && s.passwordStored ? ' · stille Neuanmeldung aktiv' : ''
    }</span></div>`;
}

export function connectPage(o: ConnectPageOpts): string {
  const msg = o.msg ? MESSAGES[o.msg] : undefined;
  const active = Boolean(o.msJob && ACTIVE_MS_STATES.has(o.msJob.state));
  const failed = o.msJob?.state === 'failed' ? o.msJob.message : undefined;
  const clientName = o.flow?.clientName ?? 'deinem KI-Assistenten';

  const header = o.flow
    ? `<span class="step">Schritt 2 von 2</span>
       <h1>projo verbinden</h1>
       <div class="sub">Angemeldet als ${escapeHtml(o.email)} – noch dein projo-Konto verbinden, danach geht es automatisch zurück zu ${escapeHtml(clientName)}.</div>`
    : `<h1>projo verbinden</h1>
       <div class="sub">Angemeldet als ${escapeHtml(o.email)}</div>`;

  let main: string;
  if (active) {
    main = msJobBox(o.msJob!, o.csrf, o.flow?.id);
  } else if (o.status.connected && !o.flow) {
    main = `${connectedBox(o.status)}
      <details><summary>Neu verbinden oder anderes Konto verwenden</summary>${connectForms(o)}</details>
      <form method="post" action="/connect/disconnect" data-inplace>
        ${hidden('csrf', o.csrf)}
        <button type="submit" class="linklike">projo-Verbindung trennen</button>
      </form>`;
  } else {
    main = `${o.status.expired ? '<div class="status warn">Die projo-Sitzung ist abgelaufen – bitte neu verbinden.</div>' : ''}
      ${connectForms(o)}`;
  }

  const body = `
    ${header}
    ${msg && !o.flow ? `<div class="${msg.cls === 'ok' ? 'status ok' : 'notice'}"${o.msg === 'connected' ? ' id="close-hint"' : ''}>${escapeHtml(msg.text)}</div>` : ''}
    ${o.error ? `<div class="error">${escapeHtml(o.error)}</div>` : ''}
    ${failed && !active ? `<div class="error">Microsoft-Anmeldung fehlgeschlagen: ${escapeHtml(failed)}</div>` : ''}
    ${main}
    ${o.flow && !active ? `<a class="skip" href="/connect/flow/${encodeURIComponent(o.flow.id)}/continue">Überspringen – projo später verbinden</a>` : ''}
    <div class="meta">Zugangsdaten werden nur hier eingegeben – nie im Chat. Gespeichert wird verschlüsselt nur die
      projo-Sitzung, ein Passwort nur auf ausdrücklichen Wunsch.</div>
    ${PAGE_SCRIPT}`;
  // Ohne JavaScript: Seite neu laden, solange die Microsoft-Anmeldung läuft (außer während der Code-Eingabe)
  const refresh = active && o.msJob?.state !== 'awaiting_code' ? '<meta http-equiv="refresh" content="3">' : '';
  return render('projo verbinden', body, refresh);
}

/** Anmeldung an diesem Server fehlt (kein mcp_session-Cookie) → SSO-Buttons bzw. lokales Formular. */
export function connectSignInPage(o: { idps: { key: string; displayName: string }[]; localEnabled: boolean; error?: string }): string {
  const buttons = o.idps
    .map((p) => `<a class="sso-btn" href="/connect/auth/${encodeURIComponent(p.key)}/start">Mit ${escapeHtml(p.displayName)} anmelden</a>`)
    .join('');
  const local = o.localEnabled
    ? `${o.idps.length > 0 ? '<div class="divider">oder</div>' : ''}
      <form method="post" action="/connect/login" accept-charset="utf-8">
        <label for="email">E-Mail</label><input id="email" name="email" type="email" required autocomplete="username">
        <label for="password">Passwort</label><input id="password" name="password" type="password" required autocomplete="current-password">
        <button type="submit">Anmelden</button>
      </form>`
    : '';
  const body = `
    <h1>Anmelden</h1>
    <div class="sub">Bitte zuerst bei ${escapeHtml(config.SERVER_NAME)} anmelden – danach kannst du dein projo-Konto verbinden.</div>
    ${buttons}${local}
    ${o.error ? `<div class="error">${escapeHtml(o.error)}</div>` : ''}`;
  return render('Anmelden', body);
}
