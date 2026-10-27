/**
 * Entwickler-Werkzeug: übernimmt eine Browser-Sitzung (Playwright storageState, z. B. aus `playwright-cli state-save`)
 * als projo-Verbindung in den Tresor – entspricht dem Ergebnis eines Microsoft-Connects, ohne Browserautomatik.
 * Nur projo-Cookies werden übernommen (Microsoft-Cookies werden verworfen).
 *
 *   npx tsx --env-file=.env scripts/vault-import.ts --email <mcp-email> --projo-email <projo-email> --state <storageState.json>
 */
import { readFileSync } from 'node:fs';
import { ProjoHttp } from '../src/projo/http.js';
import { parseProfile } from '../src/projo/pages/profile.js';
import { projoSessions } from '../src/projo/runtime.js';
import { VALIDATE_PATH } from '../src/projo/session.js';
import type { StorageState } from '../src/projo/vault.js';
import { config } from '../src/config.js';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) {
    console.error(`--${name} fehlt`);
    process.exit(2);
  }
  return v;
}

const state = JSON.parse(readFileSync(arg('state'), 'utf8')) as StorageState;
const http = await ProjoHttp.create({ baseUrl: config.PROJO_BASE_URL, storageState: state });
const page = await http.getPage(VALIDATE_PATH);
const profile = parseProfile(page.$);
const fresh = await http.storageState();
await http.dispose();

const status = await projoSessions.connectWithStorageState(arg('email'), arg('projo-email'), 'entra', fresh, profile);
await projoSessions.shutdown();
console.log(JSON.stringify({ imported: true, profileFound: Boolean(profile.userId), connected: status.connected, method: status.method }, null, 2));
