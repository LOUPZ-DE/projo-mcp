# projo-mcp

> 🇩🇪 **[Deutsche Version (Hauptdokumentation): README.md](README.md)**

**Unofficial [MCP](https://modelcontextprotocol.io) server for [projo](https://www.projo.berlin)** – the all-in-one
controlling software for architecture and engineering offices. It lets AI assistants such as Claude or Notion AI
book working hours, look up time accounts and absences, and query project controlling data in projo – with each
user's own projo account.

> ⚠️ **Status: early development.** The foundation (milestone M0) is being built; most tools below are planned.
> Not affiliated with or endorsed by projo GmbH.

## Why

projo has no public API, but a fast and stable web interface. `projo-mcp` uses that interface the way a person
would – with the person's own account and permissions – and exposes the results as MCP tools.

## How it works

```
MCP client (Claude, Notion, …) ──OAuth 2.1 + DCR──► projo-mcp ──HTTP (+ headless Chromium for MS login)──► projo
User's browser ──────────────────────────────────► /connect  (connect your projo account)
```

- **Remote MCP server** (Streamable HTTP on `/mcp`, stateless) with its own **OAuth 2.1 authorization server**
  including Dynamic Client Registration – add it as a custom connector, no manual tokens.
- **Each user connects their own projo account** on a page served by this server (`/connect`): projo email/password,
  or "Sign in with Microsoft" with MFA relay (the number or code is shown on that page). Credentials never pass
  through the chat or an LLM.
- **HTTP first:** pages are fetched and parsed, forms are submitted like a browser would (Rails CSRF tokens).
  A headless Chromium (Playwright) is only needed for the Microsoft sign-in and for recording new flows.
- **Deterministic, "trained" flows:** every write flow is recorded once from a real demonstration and then replayed
  without any AI. An optional OpenAI-compatible LLM router (e.g. Requesty) is only used as a fallback for
  extraction and to suggest repairs when projo's UI changes – never to execute writes.
- **Sessions** are stored per user, encrypted (AES-256-GCM), and kept alive (projo rolls its session cookie).

## Tools

| Milestone | Tools | Status |
|---|---|---|
| M0 Foundation | `projo_status`, `projo_read_page` (generic read-only page reader) | in progress |
| M1 Time tracking | `projo_time_entries`, `projo_time_options`, `projo_time_entry_create` / `_update` / `_delete` | planned |
| M2 Absences | vacation balance, absence list, absence requests, team view | planned |
| M3 Project controlling (read) | projects, contracts, performance / invoicing / payment status, open invoices | planned |
| M4 Project controlling (write) | invoice drafts, positions, price overviews (drafts + explicit confirmation) | planned |

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, …) so clients can decide what runs
automatically and what needs confirmation. Write tools validate their input themselves, verify the result by
re-reading projo and are written to an audit log.

## Quickstart (local)

Requirements: Node.js ≥ 22, a projo account.

```bash
cp .env.example .env
# set VAULT_KEY:       openssl rand -base64 32
# set TOKEN_SECRET / SESSION_SECRET (≥ 32 chars each)
npm install
npx playwright install chromium   # only needed for the Microsoft sign-in
npm run dev
```

Then connect an MCP client to `http://localhost:3000/mcp` (e.g. `npx @modelcontextprotocol/inspector`), sign in,
call `projo_status` and follow the link to `/connect` to connect your projo account.

### Docker

```bash
docker compose up --build        # local (Docker Desktop, OrbStack, …)
```

The image is Debian-based with Playwright's Chromium, runs as non-root and keeps all state in the `/data` volume.

## Configuration

All settings are environment variables – see [`.env.example`](.env.example) for the full, commented list.

| Variable | Required | Purpose |
|---|---|---|
| `BASE_URL` | ✓ | Public URL of this server (OAuth issuer) |
| `TOKEN_SECRET`, `SESSION_SECRET` | ✓ | Signing keys (≥ 32 chars) |
| `VAULT_KEY` | ✓ | 32-byte base64 key of the encrypted session vault |
| `AUTH_PROVIDERS` | | How users sign in to *this* server: `local`, `google`, `entra` |
| `PROJO_BASE_URL` | | Default `https://my.projo.berlin` |
| `DATA_DIR`, `STATE_FILE` | | Persistent data (use a volume in Docker) |
| `PROJO_STORE_PASSWORDS`, `PROJO_KEEP_MS_COOKIES` | | What may be stored for silent re-login |
| `KEEPALIVE_HOURS` | | Keep connected projo sessions alive (default 24 h) |
| `REQUESTY_API_KEY`, `REQUESTY_BASE_URL`, `REQUESTY_MODEL` | | Optional LLM fallback |

## Deployment notes

- Run **exactly one instance** (file-based vault and per-user locks live in the process).
- Put it behind HTTPS (most MCP clients require it); mount a persistent volume on `/data`.
- Give the container ≥ 1 GB RAM; Chromium is only started when needed.
- For "Sign in with Microsoft" from a server, Microsoft's risk detection and Conditional Access may block or
  challenge sign-ins from data-centre IPs – a fixed outbound IP registered as a named location helps.
  Email/password sign-in to projo is the most robust option.

## Connecting clients

- **Claude** (claude.ai, Desktop, Code) and **Notion Custom Agents**: add a custom MCP server with the **full URL
  including `/mcp`**; sign-in happens via OAuth in the browser.
- **MCP Inspector**: `npx @modelcontextprotocol/inspector` → Streamable HTTP → `https://<host>/mcp`.

## Security & privacy

- Each MCP user can only act with their own projo session; sessions are encrypted at rest (`VAULT_KEY`).
- Only projo cookies are kept by default. A projo password is stored only on explicit opt-in;
  a Microsoft password is never stored.
- Secrets, cookies and page contents are never logged; write actions are recorded in `DATA_DIR/audit.log`.
- The optional LLM fallback sends sanitised page HTML to the configured endpoint – use EU routing, disable
  request logging and sign a data processing agreement, or leave it disabled.

## Development

```bash
npm run typecheck && npm test
npm run discover -- --state <storageState.json> --out ./discovery /app/dates/today   # read-only discovery
```

[`docs/projo-discovery.md`](docs/projo-discovery.md) (German) documents projo's routes, forms and request formats as
far as they are known. Raw discovery output contains personal data and must never be committed (`/discovery` is ignored).

## Disclaimer

This is an independent open-source project. "projo" is a product of projo GmbH; this project is not affiliated
with, maintained or endorsed by projo GmbH. It automates the web interface with your own account – check projo's
terms of use and your organisation's policies before using it, and use it at your own risk.

## Credits & license

The OAuth 2.1 / DCR foundation is based on [test-dcr-mcp-server](https://github.com/LOUPZ-DE/test-dcr-mcp-server)
(MIT). Licensed under the [MIT License](LICENSE).
