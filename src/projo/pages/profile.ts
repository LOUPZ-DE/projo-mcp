import type { CheerioAPI } from 'cheerio';
import { cleanText } from '../util/dom.js';

/** Wer ist in dieser projo-Sitzung angemeldet? (aus der Navigationsleiste jeder App-Seite) */
export interface ProjoProfile {
  userId?: string;
  name?: string;
  /** Online-Status laut Ampel im Menü, z. B. „angemeldet“, „im Feierabend“ */
  onlineStatus?: string;
}

export function parseProfile($: CheerioAPI): ProjoProfile {
  const dropdown = $('#userDropdown');
  // <span class="d-none d-lg-inline"><span>Vorname Nachname<div class="led-box">…</div></span></span>
  const nameSpan = dropdown.find('span span').first();
  const name =
    cleanText(
      nameSpan
        .contents()
        .toArray()
        .filter((n) => n.type === 'text')
        .map((n) => ('data' in n ? String(n.data) : ''))
        .join(' '),
    ) || cleanText(dropdown.text());
  const onlineStatus = dropdown.find('.led[title]').first().attr('title');

  const profileHref = $('a[href*="/app/employees/"]').toArray().map((a) => $(a).attr('href') ?? '').find((h) => /\/app\/employees\/\d+\/contact_data/.test(h));
  const userId =
    profileHref?.match(/\/app\/employees\/(\d+)\//)?.[1] ??
    $('a[href*="user_id="]').first().attr('href')?.match(/[?&]user_id=(\d+)/)?.[1];

  return {
    ...(userId ? { userId } : {}),
    ...(name ? { name } : {}),
    ...(onlineStatus ? { onlineStatus } : {}),
  };
}
