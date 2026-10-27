/**
 * Discovery – NUR LESEND (ausschließlich GET-Requests).
 *
 * Ruft Projo-Seiten mit einer gespeicherten Browser-Sitzung (Playwright storageState) per HTTP ab –
 * exakt so, wie es der Server später tut –, legt Roh-HTML + strukturierte Zusammenfassung ab und
 * druckt einen Kurzüberblick (Tabellen, Formulare, Frames, nachladbare URLs).
 *
 *   npm run discover -- --state <storageState.json> --out <dir> [--tag modal]
 *                       [--header "X-Projo-RenderType: modal"] [--xhr] [--frames] <pfad> [<pfad> …]
 *
 * --xhr simuliert rails-ujs (`data-remote`): X-Requested-With + Accept JavaScript; das eingebettete HTML
 * der JS-Antwort wird für die Zusammenfassung extrahiert.
 *
 * ACHTUNG: Roh-HTML enthält personenbezogene Daten → --out gehört nicht ins Repo
 * (Default ./discovery ist gitignored). Bereinigte Fixtures werden separat nach test/fixtures/ übernommen.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'playwright';
import { summarizePage, type PageSummary } from '../src/projo/pages/generic.js';
import { extractHtmlFromJs } from '../src/projo/util/dom.js';

const BASE_URL = (process.env.PROJO_BASE_URL ?? 'https://my.projo.berlin').replace(/\/+$/, '');
const DENY = [/^\/logout/i, /^\/login/i, /^\/auth\//i, /^\/admin/i, /^\/cable/i, /^\/password_resets/i, /sign_out/i, /destroy/i, /delete/i];

interface Args {
  state: string;
  out: string;
  tag?: string;
  headers: Record<string, string>;
  frames: boolean;
  xhr: boolean;
  paths: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { state: '', out: 'discovery', headers: {}, frames: false, xhr: false, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--state') args.state = argv[++i]!;
    else if (a === '--out') args.out = argv[++i]!;
    else if (a === '--tag') args.tag = argv[++i]!;
    else if (a === '--frames') args.frames = true;
    else if (a === '--xhr') args.xhr = true;
    else if (a === '--header') {
      const [k, ...v] = argv[++i]!.split(':');
      args.headers[k!.trim()] = v.join(':').trim();
    } else args.paths.push(a);
  }
  if (!args.state || args.paths.length === 0) {
    console.error('Aufruf: npm run discover -- --state <storageState.json> [--out <dir>] [--tag t] [--header "K: V"] [--frames] <pfad> …');
    process.exit(2);
  }
  return args;
}

function slug(path: string, tag?: string): string {
  const s = path.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 90) || 'root';
  return tag ? `${s}__${tag}` : s;
}

function digest(path: string, status: number, bytes: number, location: string | undefined, cookieExpiry: string | undefined, s: PageSummary): string {
  const lines = [`\n=== GET ${path} → ${status}${location ? ` → ${location}` : ''} (${(bytes / 1024).toFixed(1)} KB)${cookieExpiry ? ` · _projo_session bis ${cookieExpiry}` : ''}`];
  lines.push(`title: ${s.title} | h: ${s.headings.slice(0, 6).join(' · ')}`);
  if (s.breadcrumb.length) lines.push(`breadcrumb: ${s.breadcrumb.join(' / ')}`);
  if (s.flash.length) lines.push(`flash: ${s.flash.join(' | ').slice(0, 200)}`);
  for (const t of s.tables) {
    lines.push(`table#${t.index}${t.id ? ` id=${t.id}` : ''}: [${t.headers.join(' | ')}] rows=${t.rowCount}`);
  }
  for (const f of s.forms) {
    const names = f.fields.map((x) => x.name).filter((n) => n !== 'authenticity_token');
    lines.push(`form#${f.index}${f.id ? ` id=${f.id}` : ''}: ${f.httpMethod.toUpperCase()} ${f.action ?? '(kein action)'} → ${names.join(', ').slice(0, 300)}`);
  }
  if (s.frames.length) lines.push(`frames: ${s.frames.map((f) => `${f.id}${f.src ? `<${f.src}>` : ''}`).join(', ')}`);
  if (s.lazyUrls.length) lines.push(`data-urls: ${s.lazyUrls.slice(0, 25).join(' ; ')}`);
  if (s.controllers.length) lines.push(`controllers: ${s.controllers.join(', ')}`);
  lines.push(`links: ${s.links.length}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(join(args.out, 'raw'), { recursive: true });
  mkdirSync(join(args.out, 'summary'), { recursive: true });

  const ctx = await request.newContext({
    baseURL: BASE_URL,
    storageState: args.state,
    extraHTTPHeaders: { 'Accept-Language': 'de-DE,de;q=0.9', ...args.headers },
  });

  const queue = [...args.paths];
  const done = new Set<string>();
  try {
    while (queue.length > 0) {
      const path = queue.shift()!;
      if (done.has(path)) continue;
      done.add(path);
      if (DENY.some((r) => r.test(path))) {
        console.log(`\n=== SKIP ${path} (Denylist)`);
        continue;
      }
      const headers: Record<string, string> = args.xhr
        ? { Accept: 'text/javascript, application/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' }
        : { Accept: 'text/html, application/xhtml+xml' };
      const res = await ctx.get(path, { maxRedirects: 0, headers });
      const body = await res.text();
      const isJs = /javascript/i.test(res.headers()['content-type'] ?? '');
      const html = isJs ? extractHtmlFromJs(body) : body;
      const setCookie = res.headersArray().find((h) => h.name.toLowerCase() === 'set-cookie' && h.value.startsWith('_projo_session='));
      const cookieExpiry = setCookie?.value.match(/expires=([^;]+)/i)?.[1];
      const summary = summarizePage(html, { baseUrl: BASE_URL, detail: 'full' });
      const name = slug(path, args.tag);
      writeFileSync(join(args.out, 'raw', `${name}.${isJs ? 'js' : 'html'}`), body, { mode: 0o600 });
      if (isJs) writeFileSync(join(args.out, 'raw', `${name}.extracted.html`), html, { mode: 0o600 });
      writeFileSync(
        join(args.out, 'summary', `${name}.json`),
        JSON.stringify({ path, status: res.status(), location: res.headers()['location'], contentType: res.headers()['content-type'], summary }, null, 2),
        { mode: 0o600 },
      );
      console.log(digest(path, res.status(), html.length, res.headers()['location'], cookieExpiry, summary));
      if (args.frames) {
        for (const f of summary.frames) if (f.src && !done.has(f.src)) queue.push(f.src);
      }
      await new Promise((r) => setTimeout(r, 300)); // höflich bleiben
    }
  } finally {
    await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
