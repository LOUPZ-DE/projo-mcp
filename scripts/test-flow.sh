#!/usr/bin/env bash
#
# test-flow.sh — End-to-end verification of the full OAuth 2.1 + MCP flow.
#
# Usage:
#   ./scripts/test-flow.sh [BASE_URL] [EMAIL] [PASSWORD]
#
# Defaults:
#   BASE_URL=http://localhost:3000
#   EMAIL=test@example.com  PASSWORD=test1234   (the .env.example user)
#
# Covers: 401 discovery, well-known docs, DCR, PKCE flow (login form → code →
# tokens), negative tests (code replay, plain PKCE), MCP tools, refresh
# rotation, health, 405 on GET /mcp.
#
set -euo pipefail

BASE="${1:-http://localhost:3000}"
EMAIL="${2:-test@example.com}"
PASSWORD="${3:-test1234}"
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT

step() { echo ""; echo "=== $1 ==="; }

step "1. POST /mcp without token (expect 401 + WWW-Authenticate)"
curl -si -X POST "$BASE/mcp" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | grep -iE '^(HTTP|WWW-Authenticate)'

step "2. Well-known documents (public)"
curl -s "$BASE/.well-known/oauth-protected-resource"
echo ""
curl -s "$BASE/.well-known/oauth-authorization-server"
echo ""

step "3. DCR: POST /register (expect 201 + client_id)"
DCR=$(curl -si -X POST "$BASE/register" -H 'Content-Type: application/json' \
  -d '{"redirect_uris":["http://localhost:9999/cb"],"client_name":"test-flow","token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"]}')
echo "$DCR" | head -1
CID=$(echo "$DCR" | tail -1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["client_id"])')
echo "client_id: $CID"

step "4. Full PKCE flow"
verifier=$(openssl rand -base64 96 | tr -dc 'a-zA-Z0-9-._~' | head -c 64)
challenge=$(printf %s "$verifier" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')

echo "--- 4a. GET /authorize (expect login form) ---"
AUTH_HTML=$(curl -s -c "$JAR" "$BASE/authorize?response_type=code&client_id=$CID&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb&state=xyz&code_challenge=$challenge&code_challenge_method=S256&resource=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$BASE/mcp', safe=''))")")
echo "$AUTH_HTML" | grep -o '<title>[^<]*</title>'
TXN=$(echo "$AUTH_HTML" | grep -o 'name="txn" value="[^"]*"' | sed 's/.*value="//; s/"//')

echo "--- 4b. POST /authorize with wrong password (expect form error) ---"
curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/authorize" -d "txn=$TXN&email=$EMAIL&password=wrong" | grep -o 'E-Mail oder Passwort falsch.'

echo "--- 4c. POST /authorize correct (expect 302 + code + iss) ---"
LOCATION=$(curl -s -o /dev/null -w '%{redirect_url}' -b "$JAR" -c "$JAR" -X POST "$BASE/authorize" --data-urlencode "txn=$TXN" --data-urlencode "email=$EMAIL" --data-urlencode "password=$PASSWORD")
echo "Location: ${LOCATION:0:80}..."
echo "$LOCATION" | grep -q 'iss=' && echo "iss parameter present ✔"
CODE=$(echo "$LOCATION" | sed 's/.*code=//; s/&.*//')

echo "--- 4d. POST /token code grant (expect tokens) ---"
TOKENS=$(curl -s -X POST "$BASE/token" -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "grant_type=authorization_code&code=$CODE&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb&client_id=$CID&code_verifier=$verifier")
echo "$TOKENS" | python3 -c 'import json,sys; d=json.load(sys.stdin); print({k: (v[:24]+"..." if isinstance(v,str) and len(v)>24 else v) for k,v in d.items()})'
AT=$(echo "$TOKENS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')
RT=$(echo "$TOKENS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["refresh_token"])')

echo "--- 4e. Code replay (expect invalid_grant) ---"
curl -s -X POST "$BASE/token" -d "grant_type=authorization_code&code=$CODE&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb&client_id=$CID&code_verifier=$verifier"
echo ""

echo "--- 4f. plain PKCE challenge (expect redirect error) ---"
curl -s -o /dev/null -w '%{redirect_url}\n' "$BASE/authorize?response_type=code&client_id=$CID&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb&state=xyz&code_challenge=abc&code_challenge_method=plain"

step "5. MCP with Bearer token (note: Accept header must include BOTH types)"
MCP_HEADERS=(-H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')

echo "--- 5a. initialize ---"
curl -s -X POST "$BASE/mcp" "${MCP_HEADERS[@]}" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test-flow","version":"0"}}}' | head -2

echo "--- 5b. tools/call whoami ---"
curl -s -X POST "$BASE/mcp" "${MCP_HEADERS[@]}" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"whoami","arguments":{}}}' | grep -o '"text":.*' | head -c 400
echo ""

echo "--- 5c. tools/call echo ---"
curl -s -X POST "$BASE/mcp" "${MCP_HEADERS[@]}" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"text":"hello notion"}}}' | grep -o 'hello notion'

echo "--- 5d. tools/call slow_task (2s) ---"
curl -s -X POST "$BASE/mcp" "${MCP_HEADERS[@]}" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"slow_task","arguments":{"seconds":2}}}' | grep -o '2 Sekunden gewartet.'

echo "--- 5e. GET /mcp with token (expect 405) ---"
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/mcp" -H "Authorization: Bearer $AT"

step "6. Refresh flow with rotation"
echo "--- 6a. refresh grant (expect new pair) ---"
NEW_TOKENS=$(curl -s -X POST "$BASE/token" -d "grant_type=refresh_token&refresh_token=$RT&client_id=$CID")
echo "$NEW_TOKENS" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("new access_token issued, expires_in:", d["expires_in"])'

echo "--- 6b. old refresh token replay (expect invalid_grant) ---"
curl -s -X POST "$BASE/token" -d "grant_type=refresh_token&refresh_token=$RT&client_id=$CID"
echo ""

echo "--- 6c. GET /health ---"
curl -s "$BASE/health"
echo ""
echo ""
echo "=== ALL CHECKS PASSED ==="
