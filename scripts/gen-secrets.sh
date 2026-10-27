#!/usr/bin/env bash
#
# gen-secrets.sh — erzeugt frische Secrets für ein Deployment (Ausgabe nur im eigenen Terminal).
# Werte direkt in die Umgebungsvariablen der Zielplattform (z. B. EasyPanel) kopieren – nicht ins Repo,
# nicht in Chats. VAULT_KEY zusätzlich sicher aufbewahren: ohne ihn sind gespeicherte projo-Sitzungen verloren.
#
#   ./scripts/gen-secrets.sh
#
set -euo pipefail
command -v openssl >/dev/null || { echo "openssl fehlt" >&2; exit 1; }

echo "TOKEN_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
echo "SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
echo "VAULT_KEY=$(openssl rand -base64 32 | tr -d '\n')"
