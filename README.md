# projo-mcp

> 🇬🇧 **[English version: README.en.md](README.en.md)**

**Inoffizieller [MCP](https://modelcontextprotocol.io)-Server für [projo](https://www.projo.berlin)** – die
All-in-One-Controlling-Software für Planungsbüros. Damit können KI-Assistenten wie Claude oder Notion AI
Arbeitszeiten buchen, Arbeitszeitkonto und Abwesenheiten abfragen und Daten aus der Projektführung lesen – jeweils
mit dem eigenen projo-Konto der Nutzerin bzw. des Nutzers.

> ⚠️ **Status: frühe Entwicklung.** Fundament und Zeiterfassung (M0/M1) funktionieren, weitere Bereiche sind geplant.
> Kein offizielles Produkt der projo GmbH.

## Warum

projo hat keine öffentliche API, aber eine schnelle und stabile Weboberfläche. `projo-mcp` bedient diese Oberfläche
so, wie es ein Mensch tun würde – mit dessen eigenem Konto und dessen Rechten – und stellt die Ergebnisse als
MCP-Tools bereit.

## Funktionsweise

```
MCP-Client (Claude, Notion, …) ──OAuth 2.1 + DCR──► projo-mcp ──HTTP (+ headless Chromium für MS-Login)──► projo
Browser der Nutzerin ───────────────────────────────► /connect  (eigenes projo-Konto verbinden)
```

- **Remote-MCP-Server** (Streamable HTTP auf `/mcp`, stateless) mit eigenem **OAuth-2.1-Authorization-Server**
  inkl. Dynamic Client Registration – als Custom Connector eintragen, keine manuellen Tokens.
- **Jede Person verbindet ihr eigenes projo-Konto** auf einer Seite dieses Servers (`/connect`): projo-E-Mail/Passwort
  oder „Mit Microsoft anmelden“ mit MFA-Weiterleitung (Zahl bzw. Code erscheint auf dieser Seite). Zugangsdaten
  laufen nie durch den Chat oder ein LLM.
- **HTTP zuerst:** Seiten werden abgerufen und geparst, Formulare wie im Browser abgeschickt (Rails-CSRF-Token).
  Ein headless Chromium (Playwright) wird nur für den Microsoft-Login und zum Aufzeichnen neuer Abläufe gebraucht.
- **Feste, „trainierte“ Abläufe:** Jeder Schreibablauf wird einmal aus einer echten Vorführung aufgezeichnet und
  danach ohne KI wiederholt. Ein optionaler, OpenAI-kompatibler LLM-Router (z. B. Requesty) dient nur als Reserve
  beim Auslesen und für Reparaturvorschläge, wenn sich die projo-Oberfläche ändert – nie zum Ausführen von Writes.
- **Sitzungen** werden pro Person verschlüsselt (AES-256-GCM) gespeichert und aktiv gehalten (projo verlängert
  sein Sitzungs-Cookie bei jeder Nutzung).

## Tools

| Meilenstein | Tools | Status |
|---|---|---|
| M0 Fundament | `projo_status`, `projo_read_page` (generischer, nur lesender Seitenleser), Verbindungsseite mit projo-Passwort oder Microsoft (inkl. Authenticator-Bestätigung) | fertig |
| M1 Zeiten | `projo_time_entries`, `projo_time_summary`, `projo_time_options`, `projo_time_entry_create` / `_update` / `_delete` | fertig (gegen echtes projo getestet) |
| M2 Abwesenheiten | Urlaubskonto, Abwesenheitsliste, Urlaubsantrag, Team-Ansicht | geplant |
| M3 Projektführung lesen | Projekte, Verträge, Leistungs-/Rechnungs-/Zahlungsstand, offene Rechnungen | geplant |
| M4 Projektführung schreiben | Rechnungsentwürfe, Positionen, Preisübersichten (Entwurf + ausdrückliche Bestätigung) | geplant |

Alle Tools tragen MCP-Annotations (`readOnlyHint`, `destructiveHint`, …), damit Clients entscheiden können, was
automatisch laufen darf und was eine Rückfrage braucht. Schreibende Tools prüfen ihre Eingaben selbst, kontrollieren
das Ergebnis durch erneutes Lesen und landen im Audit-Log.

## Schnellstart (lokal)

Voraussetzungen: Node.js ≥ 22, ein projo-Konto.

```bash
cp .env.example .env
# VAULT_KEY setzen:              openssl rand -base64 32
# TOKEN_SECRET / SESSION_SECRET (je ≥ 32 Zeichen) setzen
npm install
npx playwright install chromium   # nur für den Microsoft-Login nötig
npm run dev
```

Danach einen MCP-Client mit `http://localhost:3000/mcp` verbinden (z. B. `npx @modelcontextprotocol/inspector`),
anmelden, `projo_status` aufrufen und dem Link zu `/connect` folgen, um das projo-Konto zu verbinden.

### Docker

```bash
docker compose up --build        # lokal (Docker Desktop, OrbStack, …)
```

Das Image basiert auf Debian mit Playwrights Chromium, läuft ohne Root-Rechte und hält den gesamten Zustand im
Volume `/data`.

## Konfiguration

Alle Einstellungen sind Umgebungsvariablen – die vollständige, kommentierte Liste steht in
[`.env.example`](.env.example).

| Variable | Pflicht | Zweck |
|---|---|---|
| `BASE_URL` | ✓ | Öffentliche URL dieses Servers (OAuth-Issuer) |
| `TOKEN_SECRET`, `SESSION_SECRET` | ✓ | Signaturschlüssel (≥ 32 Zeichen) |
| `VAULT_KEY` | ✓ | 32-Byte-Schlüssel (base64) des verschlüsselten Sitzungs-Tresors |
| `AUTH_PROVIDERS` | | Anmeldung an *diesem* Server: `local`, `google`, `entra` |
| `PROJO_BASE_URL` | | Standard `https://my.projo.berlin` |
| `DATA_DIR`, `STATE_FILE` | | Persistente Daten (in Docker als Volume) |
| `PROJO_STORE_PASSWORDS`, `PROJO_KEEP_MS_COOKIES` | | Was für die stille Neuanmeldung gespeichert werden darf |
| `KEEPALIVE_HOURS` | | Verbundene projo-Sitzungen aktiv halten (Standard 24 h) |
| `REQUESTY_API_KEY`, `REQUESTY_BASE_URL`, `REQUESTY_MODEL` | | Optionale LLM-Reserve |

## Betrieb

Schritt-für-Schritt-Anleitung (Entra-App, Secrets, EasyPanel, Prüfung): [`docs/deployment.md`](docs/deployment.md).


- **Genau eine Instanz** betreiben (dateibasierter Tresor und Sperren pro Nutzer leben im Prozess).
- Hinter HTTPS betreiben (die meisten MCP-Clients verlangen das); ein persistentes Volume auf `/data` mounten.
- Mindestens 1 GB RAM einplanen; Chromium startet nur bei Bedarf.
- Beim „Mit Microsoft anmelden“ vom Server aus können Microsofts Risikoerkennung und Conditional Access Anmeldungen
  aus Rechenzentren blockieren oder zusätzlich prüfen – eine feste ausgehende IP als Named Location hilft.
  Am robustesten ist die Anmeldung bei projo per E-Mail/Passwort.

## Clients verbinden

- **Claude** (claude.ai, Desktop, Code) und **Notion Custom Agents**: Custom MCP Server mit der **vollständigen URL
  inkl. `/mcp`** anlegen; die Anmeldung läuft per OAuth im Browser.
- **MCP Inspector**: `npx @modelcontextprotocol/inspector` → Streamable HTTP → `https://<host>/mcp`.

## Sicherheit & Datenschutz

- Jede Person kann nur mit ihrer eigenen projo-Sitzung handeln; Sitzungen sind verschlüsselt abgelegt (`VAULT_KEY`).
- Standardmäßig werden nur projo-Cookies gespeichert. Ein projo-Passwort nur auf ausdrücklichen Wunsch, ein
  Microsoft-Passwort nie.
- Geheimnisse, Cookies und Seiteninhalte werden nicht geloggt; Schreibaktionen landen in `DATA_DIR/audit.log`.
- Die optionale LLM-Reserve schickt bereinigtes Seiten-HTML an den konfigurierten Endpunkt – EU-Routing nutzen,
  Request-Logging abschalten und einen AV-Vertrag abschließen oder die Reserve ausgeschaltet lassen.

## Entwicklung

```bash
npm run typecheck && npm test
npm run discover -- --state <storageState.json> --out ./discovery /app/dates/today   # nur lesende Discovery
```

[`docs/projo-discovery.md`](docs/projo-discovery.md) dokumentiert die bekannten Routen, Formulare und
Request-Formate von projo. Rohdaten der Discovery enthalten personenbezogene Daten und gehören nie ins Repo
(`/discovery` ist ignoriert).

## Haftungsausschluss

Dies ist ein unabhängiges Open-Source-Projekt. „projo“ ist ein Produkt der projo GmbH; dieses Projekt steht in
keiner Verbindung zur projo GmbH und wird von ihr weder betreut noch unterstützt. Es automatisiert die Weboberfläche
mit deinem eigenen Konto – prüfe vor dem Einsatz die Nutzungsbedingungen von projo und die Vorgaben deiner
Organisation; die Nutzung erfolgt auf eigene Verantwortung.

## Herkunft & Lizenz

Das OAuth-2.1-/DCR-Fundament basiert auf [test-dcr-mcp-server](https://github.com/LOUPZ-DE/test-dcr-mcp-server)
(MIT). Lizenz: [MIT](LICENSE).
