// Rendert assets/icon.svg als assets/icon.png (256×256, transparent, kantengeglättet) mit Playwrights Chromium.
//   node scripts/generate-icon.mjs
// Das SVG ist die Quelle; das PNG wird für Clients gebraucht, die kein SVG anzeigen (z. B. Notion).
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const svgPath = new URL('../assets/icon.svg', import.meta.url);
const pngPath = new URL('../assets/icon.png', import.meta.url);
const svg = readFileSync(svgPath, 'utf8');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`);
  const png = await page.locator('svg').screenshot({ omitBackground: true });
  writeFileSync(pngPath, png);
  console.log(`geschrieben: ${pngPath.pathname} (${png.length} Bytes)`);
} finally {
  await browser.close();
}
