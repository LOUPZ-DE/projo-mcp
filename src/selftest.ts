/**
 * Selbsttest für Container/Deployment: startet Chromium headless, rendert eine Seite, beendet sich.
 *   docker run --rm projo-mcp:local node dist/selftest.js
 * Braucht keine Konfiguration (kein Import von config.ts).
 */
import { chromium } from 'playwright';

const started = Date.now();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<h1>projo-mcp selftest</h1>');
  const text = await page.textContent('h1');
  const ok = text === 'projo-mcp selftest';
  console.log(JSON.stringify({ ok, chromium: browser.version(), node: process.version, ms: Date.now() - started }));
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
