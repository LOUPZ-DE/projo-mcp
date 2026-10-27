import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config.ts liest die Umgebung beim Import – hier eine gültige Testkonfiguration bereitstellen.
const dataDir = mkdtempSync(join(tmpdir(), 'projo-mcp-test-'));
const defaults: Record<string, string> = {
  BASE_URL: 'http://localhost:3999',
  TOKEN_SECRET: 'test-token-secret-0123456789-abcdefghijkl',
  SESSION_SECRET: 'test-session-secret-0123456789-abcdefghij',
  VAULT_KEY: randomBytes(32).toString('base64'),
  DATA_DIR: dataDir,
  AUTH_PROVIDERS: 'local',
  USERS_JSON: '[{"email":"test@example.com","password":"test1234","name":"Test User"}]',
  PROJO_BASE_URL: 'http://127.0.0.1:1',
  KEEPALIVE_HOURS: '0',
};
// Bewusst überschreiben: Vitest setzt selbst BASE_URL='/' (Vite-Konvention), lokale .env-Werte sollen Tests nicht beeinflussen.
for (const [k, v] of Object.entries(defaults)) process.env[k] = v;
