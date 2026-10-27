#!/usr/bin/env bash
#
# mcp-call.sh — einzelnen Tool-Aufruf gegen einen LOKALEN Server ausführen (nur Entwicklung, Provider 'local').
# Holt per DCR + PKCE ein Token für den Testnutzer und ruft das Tool auf; Ausgabe = Text-Inhalt der Antwort.
#
#   ./scripts/mcp-call.sh <tool> '<arguments-json>' [BASE_URL] [EMAIL] [PASSWORD]
#   ./scripts/mcp-call.sh projo_read_page '{"path":"/app/dates/today"}'
#
set -euo pipefail

TOOL="${1:?Tool-Name fehlt}"
ARGS="${2:-{\}}"
BASE="${3:-http://localhost:3000}"
EMAIL="${4:-test@example.com}"
PASSWORD="${5:-test1234}"
JAR=$(mktemp)
trap 'rm -f "$JAR"' EXIT

CID=$(curl -s -X POST "$BASE/register" -H 'Content-Type: application/json' \
  -d '{"redirect_uris":["http://localhost:9999/cb"],"client_name":"mcp-call","token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"]}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["client_id"])')
verifier=$(openssl rand -base64 96 | tr -dc 'a-zA-Z0-9-._~' | head -c 64)
challenge=$(printf %s "$verifier" | openssl dgst -sha256 -binary | base64 | tr '+/' '-_' | tr -d '=')
TXN=$(curl -s -c "$JAR" "$BASE/authorize?response_type=code&client_id=$CID&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb&state=s&code_challenge=$challenge&code_challenge_method=S256" \
  | grep -o 'name="txn" value="[^"]*"' | sed 's/.*value="//; s/"//')
LOCATION=$(curl -s -o /dev/null -w '%{redirect_url}' -b "$JAR" -c "$JAR" -X POST "$BASE/authorize" \
  --data-urlencode "txn=$TXN" --data-urlencode "email=$EMAIL" --data-urlencode "password=$PASSWORD")
CODE=$(echo "$LOCATION" | sed 's/.*code=//; s/&.*//')
AT=$(curl -s -X POST "$BASE/token" -d "grant_type=authorization_code&code=$CODE&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb&client_id=$CID&code_verifier=$verifier" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')

PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":sys.argv[1],"arguments":json.loads(sys.argv[2])}}))' "$TOOL" "$ARGS")
curl -s -X POST "$BASE/mcp" -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$PAYLOAD" \
  | sed -n 's/^data: //p' \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)
r=d.get("result",{})
if r.get("isError"): print("[isError]")
for c in r.get("content",[]): print(c.get("text",""))
if "error" in d: print(json.dumps(d["error"], ensure_ascii=False))'
