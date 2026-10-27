import { config } from '../config.js';
import type { EntraJobStatus } from '../projo/auth/entra.js';
import type { ConnectionStatus } from '../projo/session.js';
import { escapeHtml, widePage } from '../util/html.js';

/** Server-gerenderte Seiten der Verbindungsseite (/connect) – bewusst ohne Client-Framework. */

const EXTRA_CSS = `
<style>
  .status { border-radius: 8px; padding: .75rem 1rem; margin: 1rem 0; font-size: .9rem; line-height: 1.45; }
  .status.ok { background: #064e3b; color: #a7f3d0; }
  .status.warn { background: #78350f; color: #fde68a; }
  .status.none { background: #334155; color: #e2e8f0; }
  .notice { background: #0c4a6e; color: #bae6fd; border-radius: 8px; padding: .5rem .75rem; font-size: .85rem; margin-top: 1rem; }
  h2 { font-size: 1rem; margin: 1.75rem 0 .25rem; }
  .check { display: flex; gap: .5rem; align-items: flex-start; margin-top: .9rem; font-size: .8rem; color: #94a3b8; }
  .check input { width: auto; margin-top: .15rem; }
  .secondary { background: #334155; color: #e2e8f0; }
  .secondary:hover { background: #475569; }
  .danger { background: #7f1d1d; color: #fecaca; }
  .danger:hover { background: #991b1b; }
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

function statusBox(s: ConnectionStatus): string {
  if (!s.method) return `<div class="status none">Noch kein projo-Konto verbunden.</div>`;
  const who = escapeHtml(s.projoUserName ? `${s.projoUserName} (${s.projoEmail})` : (s.projoEmail ?? ''));
  const method = s.method === 'entra' ? 'Microsoft' : 'projo-Passwort';
  if (s.expired) {
    return `<div class="status warn">Die projo-Sitzung für <b>${who}</b> ist abgelaufen – bitte unten neu verbinden.</div>`;
  }
  return `<div class="status ok">Verbunden mit projo als <b>${who}</b><br>
    Anmeldung: ${method} · verbunden seit ${fmt(s.connectedAt)} · zuletzt geprüft ${fmt(s.lastValidatedAt)}
    ${s.method === 'password' ? `<br>Passwort gespeichert: ${s.passwordStored ? 'ja (stille Neuanmeldung aktiv)' : 'nein'}` : ''}</div>`;
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
}

const ACTIVE_MS_STATES = new Set(['starting', 'microsoft', 'awaiting_approval', 'awaiting_code', 'finishing']);

/**
 * Live-Status der Microsoft-Anmeldung. Funktioniert auch ohne JavaScript: Solange die Anmeldung läuft,
 * lädt sich die Seite per <meta refresh> neu (Zahl serverseitig gerendert). Das Script beschleunigt nur,
 * löscht nie Inhalte und lädt bei Abschluss die Seite neu.
 */
function msJobBox(job: EntraJobStatus, csrf: string): string {
  return `
    <div id="ms-job" class="status none" data-csrf="${escapeHtml(csrf)}" data-state="${escapeHtml(job.state)}">
      <div id="ms-msg">${escapeHtml(job.message)}</div>
      <div id="ms-number" class="mfa-number"${job.number ? '' : ' hidden'}>${escapeHtml(job.number ?? '')}</div>
      <form id="ms-code" method="post" action="/connect/mfa"${job.state === 'awaiting_code' ? '' : ' hidden'}>
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <label for="ms_code">Bestätigungscode</label>
        <input id="ms_code" name="code" inputmode="numeric" autocomplete="one-time-code" required>
        <button type="submit">Code senden</button>
      </form>
      <div class="meta">Die Anzeige aktualisiert sich automatisch – falls sich nichts tut, die Seite neu laden.</div>
      <form id="ms-cancel" method="post" action="/connect/microsoft/cancel" data-inplace>
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <button type="submit" class="secondary">Abbrechen</button>
      </form>
    </div>
    <script>
    (() => {
      const box = document.getElementById('ms-job');
      if (!box) return;
      const msg = document.getElementById('ms-msg');
      const num = document.getElementById('ms-number');
      const codeForm = document.getElementById('ms-code');
      let state = box.dataset.state;
      let timer;
      const apply = (s) => {
        if (!s || !s.state || s.state === 'none') return;
        if (s.state === 'done' || s.state === 'failed') {
          clearInterval(timer);
          location.replace(s.state === 'done' ? '/connect?msg=connected' : '/connect');
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
        history.replaceState(null, '', '/connect');
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

export function connectPage(o: ConnectPageOpts): string {
  const msg = o.msg ? MESSAGES[o.msg] : undefined;
  const defaultProjoEmail = escapeHtml(o.status.projoEmail ?? o.email);
  const body = `
    <h1>projo verbinden</h1>
    <div class="sub">Angemeldet als ${escapeHtml(o.email)} · ${escapeHtml(config.SERVER_NAME)}</div>
    ${msg ? `<div class="${msg.cls === 'ok' ? 'status ok' : 'notice'}"${o.msg === 'connected' ? ' id="close-hint"' : ''}>${escapeHtml(msg.text)}</div>` : ''}
    ${o.error ? `<div class="error">${escapeHtml(o.error)}</div>` : ''}
    ${statusBox(o.status)}

    <h2>Mit projo-E-Mail und Passwort</h2>
    <form method="post" action="/connect/password" accept-charset="utf-8" autocomplete="off" data-inplace>
      <input type="hidden" name="csrf" value="${escapeHtml(o.csrf)}">
      <label for="projo_email">projo-E-Mail</label>
      <input id="projo_email" name="projo_email" type="email" required value="${defaultProjoEmail}" autocomplete="username">
      <label for="projo_password">projo-Passwort</label>
      <input id="projo_password" name="projo_password" type="password" required autocomplete="current-password">
      ${o.allowStorePassword ? `<label class="check"><input type="checkbox" name="store_password" value="1">
        <span>Passwort verschlüsselt speichern, damit sich der Server bei abgelaufener Sitzung selbst neu anmelden kann.</span></label>` : ''}
      <button type="submit">Verbinden</button>
    </form>

    ${o.msJob && ACTIVE_MS_STATES.has(o.msJob.state) ? `<h2>Anmeldung mit Microsoft</h2>${msJobBox(o.msJob, o.csrf)}` : ''}
    ${o.msJob?.state === 'failed' ? `<div class="error">Microsoft-Anmeldung fehlgeschlagen: ${escapeHtml(o.msJob.message)}</div>` : ''}

    ${o.microsoftAvailable && !(o.msJob && ACTIVE_MS_STATES.has(o.msJob.state)) ? `
    <h2>Mit Microsoft („Mit Microsoft anmelden“ in projo)</h2>
    <form method="post" action="/connect/microsoft" accept-charset="utf-8" autocomplete="off" data-inplace>
      <input type="hidden" name="csrf" value="${escapeHtml(o.csrf)}">
      <label for="ms_email">Microsoft-Konto</label>
      <input id="ms_email" name="ms_email" type="email" required value="${defaultProjoEmail}" autocomplete="username">
      <label for="ms_password">Microsoft-Passwort (nur nötig, wenn Microsoft danach fragt – bei Anmeldung per Authenticator-App leer lassen)</label>
      <input id="ms_password" name="ms_password" type="password" autocomplete="current-password">
      <button type="submit" class="secondary">Mit Microsoft verbinden</button>
    </form>
    <div class="meta">Der Server meldet sich dabei in einem eigenen Browser bei Microsoft an. Die Zahl für die
      Authenticator-App bzw. ein Code-Feld erscheint hier. Ein Microsoft-Passwort wird nie gespeichert.</div>` : ''}

    ${o.status.method ? `
    <h2>Verbindung trennen</h2>
    <form method="post" action="/connect/disconnect" data-inplace>
      <input type="hidden" name="csrf" value="${escapeHtml(o.csrf)}">
      <button type="submit" class="danger">projo-Verbindung trennen</button>
    </form>` : ''}

    <div class="meta">Zugangsdaten werden nur auf dieser Seite eingegeben – nie im Chat. Gespeichert wird verschlüsselt
      die projo-Sitzung (Cookies), ein Passwort nur auf ausdrücklichen Wunsch.</div>
    ${PAGE_SCRIPT}`;
  // Ohne JavaScript: Seite neu laden, solange die Microsoft-Anmeldung läuft (außer während der Code-Eingabe)
  const active = Boolean(o.msJob && ACTIVE_MS_STATES.has(o.msJob.state));
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
