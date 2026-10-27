# Deployment (EasyPanel o. ä.)

`projo-mcp` ist ein einzelner Docker-Container (Debian + Chromium, ~1,9 GB Image, läuft als `node`). Alles,
was Neustarts überleben muss, liegt im Volume `/data`: OAuth-Zustand (`state.json`), der verschlüsselte
Sitzungs-Tresor (`vault/`) und das Audit-Log (`audit.log`).

> **Wichtig:** genau **eine** Instanz betreiben (Tresor und Sperren pro Nutzer leben im Prozess).

## 1. Microsoft Entra: App-Registrierung für die Anmeldung am MCP-Server

Damit sich Mitarbeitende mit ihrem Microsoft-Konto am MCP-Server anmelden (`AUTH_PROVIDERS=entra`):

1. [Entra Admin Center](https://entra.microsoft.com) → **Identität → Anwendungen → App-Registrierungen → Neue Registrierung**
2. Name z. B. `projo-mcp`, **Nur Konten in diesem Organisationsverzeichnis (Single-Tenant)**
3. Umleitungs-URI, Plattform **Web**:
   - `https://<domain>/auth/entra/callback` (Anmeldung beim Verbinden des Connectors)
   - `https://<domain>/connect/auth/entra/callback` (Anmeldung direkt auf der Verbindungsseite)
4. **Zertifikate & Geheimnisse → Neuer geheimer Clientschlüssel** → Wert sofort kopieren
5. Von der Übersichtsseite: **Verzeichnis-ID (Mandant)** und **Anwendungs-ID (Client)**

Keine zusätzlichen API-Berechtigungen nötig (`openid email profile`).

> Das ist eine andere App als die, mit der projo selbst „Mit Microsoft anmelden“ anbietet.

## 2. Secrets erzeugen

```bash
./scripts/gen-secrets.sh
```

Gibt `TOKEN_SECRET`, `SESSION_SECRET` und `VAULT_KEY` aus – nur im eigenen Terminal, direkt in die Plattform
kopieren. **`VAULT_KEY` zusätzlich im Passwortmanager ablegen**: Geht er verloren, müssen alle Nutzer projo neu
verbinden; wird er bekannt, sind die gespeicherten projo-Sitzungen gefährdet (dann neuen Schlüssel setzen und
`/data/vault` leeren).

## 3. EasyPanel: App-Service anlegen

1. **Create Service → App**, Name z. B. `projo-mcp`
2. **Source:** GitHub-Repo `LOUPZ-DE/projo-mcp`, Branch `main` (EasyPanel braucht Zugriff auf das private Repo:
   Settings → GitHub) – **Build:** Dockerfile (im Repo-Root, wird erkannt)
3. **Environment:**

   ```env
   BASE_URL=https://<domain>
   TOKEN_SECRET=<aus gen-secrets.sh>
   SESSION_SECRET=<aus gen-secrets.sh>
   VAULT_KEY=<aus gen-secrets.sh>
   AUTH_PROVIDERS=entra
   ENTRA_TENANT_ID=<Verzeichnis-ID>
   ENTRA_CLIENT_ID=<Anwendungs-ID>
   ENTRA_CLIENT_SECRET=<Clientschlüssel>
   SSO_ALLOWED_DOMAINS=<eure-mail-domain>
   ```

   `DATA_DIR=/data` und `STATE_FILE=/data/state.json` setzt das Image selbst. Optional: `KEEPALIVE_HOURS` (24),
   `ACCESS_TOKEN_TTL` (3600), `PROJO_STORE_PASSWORDS` (true), `REQUESTY_*` (LLM-Reserve, siehe `.env.example`).
4. **Mounts:** Volume, Mount-Pfad `/data`
5. **Domains:** `<domain>` → Container-Port **3000**, HTTPS an
6. **Advanced:** Replicas **1**; „Tini as init“ optional (das Image bringt tini mit); ≥ 1 GB RAM
7. **Deploy**

## 4. Prüfen

```bash
curl https://<domain>/health                                   # {"status":"ok"}
curl https://<domain>/.well-known/oauth-protected-resource     # resource = https://<domain>/mcp
```

- `https://<domain>/` zeigt die Info-Seite, `https://<domain>/connect` die Verbindungsseite (nach Microsoft-Anmeldung).
- Selbsttest im Container (EasyPanel → Console): `node dist/selftest.js` → `{"ok":true,…}`
- MCP Inspector: `npx @modelcontextprotocol/inspector` → Streamable HTTP → `https://<domain>/mcp`

## 5. In Clients einbinden

- **Claude** (claude.ai → Einstellungen → Connectors → Custom Connector) bzw. **Notion** (Settings → Notion AI →
  AI connectors → Custom MCP servers): URL **`https://<domain>/mcp`** (inkl. `/mcp`), Anmeldung per OAuth.
- Danach im Chat: „Wie ist mein projo-Status?“ → `projo_status` liefert ggf. den Link zur Verbindungsseite.

## Hinweise

- **Microsoft-Login bei projo** (für Konten ohne projo-Passwort) ist noch in Arbeit (Meilenstein M0.7). Bis dahin
  verbinden sich Nutzer auf `/connect` mit projo-E-Mail und -Passwort.
- Logs sind JSON-Zeilen auf stdout (EasyPanel → Logs); Passwörter, Codes und Cookies werden nie geloggt.
- Update: Push auf `main` → in EasyPanel neu deployen (oder Auto-Deploy aktivieren). Der Tresor bleibt erhalten.
