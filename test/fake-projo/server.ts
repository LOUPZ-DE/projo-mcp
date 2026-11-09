import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';

/**
 * Minimaler projo-Nachbau für Offline-Tests: Rails-artiger Login mit CSRF, rollierendes
 * Sitzungs-Cookie (+14 Tage bei jedem Request), Redirect auf eine absolute /login-URL bei
 * fehlender Anmeldung und Zähler für parallele Requests.
 */

export interface FakeBooking {
  id: string;
  date: string;
  taskId: string;
  minutes: number;
  description: string;
}

export interface FakeProjo {
  url: string;
  accounts: Map<string, string>;
  requests: { method: string; path: string; body?: Record<string, string> }[];
  bookings: Map<string, FakeBooking>;
  /**
   * rejectCsrf: Writes immer wie bei ungültigem CSRF-Token beantworten; treeBroken: Leistungsbaum mit fremdem Format;
   * lockedDays: Tage im gesperrten Zeitraum ohne Buchung (kein Button „Zeitbuchung“)
   */
  state: { rejectCsrf: boolean; treeBroken: boolean; lockedDays: Set<string> };
  /** aktuell gefilterter Vertrag (treatyId) */
  activeTreaty(): string | undefined;
  seedBooking(b: Omit<FakeBooking, 'id' | 'description'> & { description?: string }): string;
  /** höchste Anzahl gleichzeitig laufender Requests */
  maxConcurrent(): number;
  /** alle Sitzungen serverseitig abmelden (simuliert Ablauf) */
  expireAll(): void;
  close(): Promise<void>;
}

interface FakeSession {
  auth: boolean;
  csrf: string;
}

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

export async function startFakeProjo(): Promise<FakeProjo> {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const sessions = new Map<string, FakeSession>();
  const accounts = new Map<string, string>([['erika@example.com', 'geheim']]);
  const requests: FakeProjo['requests'] = [];
  let active = 0;
  let maxConcurrent = 0;
  let url = '';

  app.use((req: Request, res: Response, next: NextFunction) => {
    requests.push({ method: req.method, path: req.originalUrl, ...(req.body && Object.keys(req.body).length ? { body: req.body as Record<string, string> } : {}) });
    active++;
    maxConcurrent = Math.max(maxConcurrent, active);
    res.on('finish', () => active--);
    setTimeout(next, 15); // etwas Latenz, damit Parallelität messbar wird
  });

  function session(req: Request, res: Response): FakeSession {
    const sid = /(?:^|;\s*)_projo_session=([^;]+)/.exec(req.get('cookie') ?? '')?.[1];
    let s = sid ? sessions.get(sid) : undefined;
    let id = sid;
    if (!s || !id) {
      id = randomBytes(12).toString('hex');
      s = { auth: false, csrf: randomBytes(8).toString('hex') };
      sessions.set(id, s);
    }
    // rollierend wie projo: jedes Mal neu gesetzt, 14 Tage gültig
    res.cookie('_projo_session', id, { httpOnly: true, sameSite: 'lax', path: '/', expires: new Date(Date.now() + 14 * 86_400_000) });
    return s;
  }

  const loginPage = (s: FakeSession, flash = '') => fixture('login.html').replace('{{TOKEN}}', s.csrf).replace('{{FLASH}}', flash);

  app.get('/login', (req, res) => {
    res.send(loginPage(session(req, res)));
  });

  app.post('/login', (req, res) => {
    const s = session(req, res);
    const body = req.body as Record<string, string>;
    if (body.authenticity_token !== s.csrf) {
      res.status(422).send('ActionController::InvalidAuthenticityToken');
      return;
    }
    if (accounts.get(body['session[email]'] ?? '') === body['session[password]']) {
      s.auth = true;
      res.redirect(302, `${url}/app/dates/today`);
      return;
    }
    res.status(200).send(loginPage(s, '<div class="alert alert-danger">E-Mail oder Passwort ungültig</div>'));
  });

  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!session(req, res).auth) {
      res.redirect(302, `${url}/login`);
      return;
    }
    next();
  };

  app.get('/app/dates/today', requireAuth, (_req, res) => {
    res.send(fixture('day.html'));
  });

  app.post('/logout', (req, res) => {
    session(req, res).auth = false;
    res.redirect(302, `${url}/login`);
  });

  // ─── Zeiterfassung (vereinfachter Nachbau; Verhalten wie in docs/projo-discovery.md) ──────────────
  const META = 'meta-csrf-token';
  const contractsById: Record<string, { code: string; title: string }> = {
    '700001': { code: '1000-Projekt-01', title: 'Neubau Musterschule' },
    '700002': { code: '2000-Intern-08', title: 'Interne Leistungen' },
  };
  // Leistungsbaum je Vertrag („alle Leistungen“); Zeilen ohne taskId sind Gruppen bzw. nicht buchbar
  const treeRows: Record<string, { number: string; name: string; taskId?: string; status?: string }[]> = {
    '700001': [
      { number: '2', name: 'Leistungsstufe 2' },
      { number: '2.1', name: 'Kostenmanagement' },
      { number: '2.1.1', name: 'Kostensteuerung zur Einhaltung der Kostenziele' },
      { number: '2.1.1.1', name: 'Standort Nord', taskId: '6100001' },
      { number: '2.1.1.2', name: 'Standort Süd', taskId: '6100002' },
      { number: '2.1.2', name: 'Kostenkontrolle' },
      { number: '2.1.2.1', name: 'Standort Nord', taskId: '6100004' },
      { number: '2.1.2.2', name: 'Standort Süd', taskId: '6100005', status: 'nicht abrechenbar' },
      { number: '2.1.2.3', name: 'Standort West', status: 'fertig' },
      { number: '2.1.3', name: 'Basisprojekt', taskId: '6100003' },
    ],
    '700002': [
      { number: '1', name: 'Hardware', taskId: '6000001' },
      { number: '2', name: 'IT-Support', taskId: '6000002' },
      { number: '3', name: 'Eigenentwicklungen' },
      { number: '3.1', name: 'Werkzeug A', taskId: '6000003' },
    ],
  };
  // buchbare Leistungen wie im Leistungs-Select: voller Pfad mit " - "
  const tasks: Record<string, { treaty: string; name: string }> = {};
  for (const [treaty, rows] of Object.entries(treeRows)) {
    for (const r of rows) {
      if (!r.taskId) continue;
      const path = rows.filter((p) => r.number.startsWith(`${p.number}.`)).map((p) => p.name);
      tasks[r.taskId] = { treaty, name: [...path, r.name].join(' - ') };
    }
  }
  const leafOf = (taskId: string) => `5${taskId.slice(1)}`;
  const bookings = new Map<string, FakeBooking>();
  let nextId = 900000100;
  let activeTreaty: string | undefined = '700002';

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const fmt = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')} h`;
  const parseHm = (v: string | undefined) => {
    const m = /^(\d{1,2}):(\d{2}) h$/.exec(v ?? '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
  };
  const labelOf = (taskId: string) => {
    const t = tasks[taskId];
    return t ? { label: `${contractsById[t.treaty]!.code} - ${t.name}`, title: t.name } : { label: '', title: '' };
  };
  /** wie Rails' escape_javascript */
  const escapeJs = (s: string) => s.replace(/\\/g, '\\\\').replace(/<\//g, '<\\/').replace(/\r?\n/g, '\\n').replace(/"/g, '\\"').replace(/'/g, "\\'");

  const showHtml = (date: string) => {
    const rows = [...bookings.values()]
      .filter((b) => b.date === date)
      .map((b) => {
        const { label, title } = labelOf(b.taskId);
        return `<tr id="booking-${b.id}" data-row-id="${b.id}">
          <td><span class="best_in_place duration" data-bip-attribute="duration_in_hour_min_str" data-bip-value="${fmt(b.minutes)}">${fmt(b.minutes)}</span></td>
          <td><span class="label text-nowrap" title="${esc(title)}">${esc(label)}</span></td>
          <td><span class="best_in_place" data-bip-attribute="description">${esc(b.description)}</span></td>
          <td><a data-remote="true" rel="nofollow" data-method="delete" href="${url}/app/bookings/${b.id}?date=${date}&amp;user_id=1001">x</a></td>
        </tr>`;
      })
      .join('\n');
    return `<a data-modal="true" class="btn btn-primary" href="${url}/app/bookings/new?date=${date}&amp;user_id=1001">Zeitbuchung</a>
      <table class="table"><thead><tr><th>Dauer</th><th>Leistung</th><th>Rechnungskommentar</th><th></th></tr></thead>
      <tbody id="sortable-parent">${rows}</tbody></table>`;
  };
  const dayPage = (date: string) =>
    fixture('day.html')
      .replaceAll('https://my.projo.berlin', url)
      .replace(/<div id="show">[\s\S]*?<\/div>\s*<\/div>\s*<\/body>/, () => `<div id="show">${showHtml(date)}</div></div></body>`);
  const showJs = (date: string) => `$("#show").html("${escapeJs(showHtml(date))}");`;
  const taskSelect = (ids: string[]) =>
    `<select name="time_tracking_booking[task_id]"><option value=""></option>${ids
      .map((id) => `<option data-time-tracking-leaf-url="/time_tracking/leaves/${leafOf(id)}" value="${id}">${esc(tasks[id]!.name)}</option>`)
      .join('')}</select>`;
  /** projo behandelt Writes ohne gültiges CSRF-Header-Token als „nicht angemeldet“ (Sitzung bleibt gültig). */
  const csrfOk = (req: Request, res: Response) => {
    if (state.rejectCsrf || req.get('x-csrf-token') !== META) {
      res.type('text/javascript').send(`Turbo.cache.clear()\nTurbo.visit("${url}/login", {"action":"replace"})`);
      return false;
    }
    return true;
  };
  const state = { rejectCsrf: false, treeBroken: false, lockedDays: new Set<string>() };

  app.get('/app/dates/:date', requireAuth, (req, res) => {
    const date = String(req.params.date);
    if (state.lockedDays.has(date)) {
      res.send(fixture('day-locked.html').replaceAll('https://my.projo.berlin', url).replaceAll('2026-10-26', date));
      return;
    }
    res.send(dayPage(date));
  });

  const treeHtml = (treaty: string) => {
    const rows = treeRows[treaty]!;
    const body = rows
      .map((r) => {
        const level = r.number.split('.').length;
        const group = rows.some((x) => x.number.startsWith(`${r.number}.`));
        const name = r.taskId
          ? `<a data-remote="true" rel="nofollow" data-method="patch" href="${url}/app/structure_bookings/${leafOf(r.taskId)}/leaf_chosen?user_id=1001">${esc(r.name)}</a>`
          : esc(r.name);
        const cls = r.taskId ? '' : group ? 'big_leaf_group' : 'text-decoration-line-through hide';
        return `<tr class=" ${cls} "><td>${r.number}</td><td style="padding-left:${(0.5 + (level - 1) * 1.2).toFixed(1)}em">${name}</td><td><span class="badge">${r.status ?? 'laufend'}</span></td></tr>`;
      })
      .join('');
    const c = contractsById[treaty]!;
    return `<div class="modal-body" id="treaty_tree">Projekt: <span class="label label-sub"><span title="${esc(c.title)}">${esc(c.code)}</span></span>
      <table class="table table-bordered table-hover" id="treaty_tree"><thead><th></th><th>Leistung</th><th></th></thead><tbody>${body}</tbody></table></div>`;
  };

  // „alle Leistungen“: reiner GET (XHR), ändert den Vertragsfilter nicht
  app.get('/app/structure_bookings/new', requireAuth, (req, res) => {
    const treaty = String(req.query.treaty_id ?? '');
    const html = state.treeBroken || !treeRows[treaty] ? '<div class="modal-body"><p>Wartungsarbeiten</p></div>' : treeHtml(treaty);
    res.type('text/javascript').send(`$("#create_booking_form").hide();\n$("#new_one_off_booking").html("${escapeJs(html)}").show();`);
  });

  app.get('/app/bookings/new', requireAuth, (req, res) => {
    const date = String(req.query.date ?? '2026-03-10');
    res.send(fixture('booking-new.html').replaceAll('https://my.projo.berlin', url).replaceAll('2026-03-10', date));
  });

  app.post('/app/bookings', requireAuth, (req, res) => {
    if (!csrfOk(req, res)) return;
    const date = String(req.query.date);
    const body = req.body as Record<string, string>;
    const id = String(nextId++);
    bookings.set(id, {
      id,
      date,
      taskId: body['time_tracking_booking[task_id]'] ?? '',
      minutes: parseHm(body['time_tracking_booking[duration_in_hour_min_str]']) ?? 0,
      description: (body['time_tracking_booking[description]'] ?? '').trim(),
    });
    res.type('text/javascript').send(showJs(date));
  });

  app.put('/app/bookings/:id', requireAuth, (req, res) => {
    if (!csrfOk(req, res)) return;
    const b = bookings.get(String(req.params.id));
    const body = req.body as Record<string, string>;
    if (b) {
      const minutes = parseHm(body['time_tracking_booking[duration_in_hour_min_str]']);
      if (minutes !== undefined) b.minutes = minutes; // ungültige Werte ignoriert projo still
      if (body['time_tracking_booking[description]'] !== undefined) b.description = body['time_tracking_booking[description]']!;
    }
    res.status(204).end();
  });

  app.patch('/app/bookings/:id/update_task', requireAuth, (req, res) => {
    if (!csrfOk(req, res)) return;
    const b = bookings.get(String(req.params.id));
    if (b) b.taskId = String(req.query.task_id);
    res.type('text/javascript').send(showJs(String(req.query.date)));
  });

  app.delete('/app/bookings/:id', requireAuth, (req, res) => {
    if (!csrfOk(req, res)) return;
    bookings.delete(String(req.params.id));
    res.type('text/javascript').send(showJs(String(req.query.date)));
  });

  app.get('/app/bookings/:id/edit_task', requireAuth, (req, res) => {
    const options = Object.keys(tasks)
      .map((id) => {
        const { label } = labelOf(id);
        const short = label.length > 60 ? `${label.slice(0, 30)} ... ${label.slice(-20)}` : label;
        return `<option data-url="${url}/app/bookings/${req.params.id}/update_task?date=${req.query.date}&amp;task_id=${id}&amp;user_id=1001" data-remote="true" data-method="PATCH" value="${id}">${esc(short)}</option>`;
      })
      .join('');
    res.type('text/javascript').send(`$("#modal-holder").html("${escapeJs(`<select class="select2 js-go_to_url">${options}</select>`)}");`);
  });

  app.patch('/app/dates/:date/filter_treaty', requireAuth, (req, res) => {
    if (!csrfOk(req, res)) return;
    activeTreaty = req.query.filtered_treaty_id ? String(req.query.filtered_treaty_id) : undefined;
    const ids = Object.keys(tasks).filter((id) => tasks[id]!.treaty === activeTreaty);
    res.type('text/javascript').send(`$("#filtered_tasks_as_input").html("${escapeJs(`<form id="new_time_tracking_booking">${taskSelect(ids)}</form>`)}");`);
  });

  app.get('/app/months', requireAuth, (_req, res) => {
    res.send(`<html><body><div id="over_time"><div class="col"><h3>00:00 h</h3><span class="text-secondary">Gebuchte Stunden</span></div></div></body></html>`);
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    accounts,
    requests,
    bookings,
    state,
    activeTreaty: () => activeTreaty,
    seedBooking: (b) => {
      const id = String(nextId++);
      bookings.set(id, { id, description: '', ...b });
      return id;
    },
    maxConcurrent: () => maxConcurrent,
    expireAll: () => {
      for (const s of sessions.values()) s.auth = false;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
