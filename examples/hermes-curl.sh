#!/usr/bin/env bash
# dsh-session-inject — Hermes-side example.
#
# Lists live DSH sessions and injects a user turn into one of them, waiting for
# the final reply text.
#
#   ./hermes-curl.sh                       # list sessions
#   ./hermes-curl.sh <session-id> "内容"   # inject and wait for the reply
#
# Env:
#   DSH_SESSION_INJECT_URL    default http://127.0.0.1:3090/mcp/session-inject
#   DSH_SESSION_INJECT_TOKEN  optional bearer token (must match the Host config)
set -euo pipefail

URL="${DSH_SESSION_INJECT_URL:-http://127.0.0.1:3090/mcp/session-inject}"
SESSION_ID="${1:-}"
CONTENT="${2:-请只回复 INJECT-OK}"

AUTH=()
if [ -n "${DSH_SESSION_INJECT_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: Bearer ${DSH_SESSION_INJECT_TOKEN}")
fi

rpc() {
  curl -sS -X POST "$URL" \
    -H 'content-type: application/json' \
    "${AUTH[@]}" \
    --data-binary "$1"
}

if [ -z "$SESSION_ID" ]; then
  rpc '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sessions_list","arguments":{}}}'
  exit 0
fi

# JSON-escape the content: backslash and double quote; newlines become spaces
# so the payload stays a single-line JSON string (sed/tr only, no python).
ESCAPED=$(printf '%s' "$CONTENT" | tr '\n' ' ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
PAYLOAD=$(printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"session_inject","arguments":{"session_id":"%s","content":"%s","delivery":"queue","wait_ms":180000}}}' "$SESSION_ID" "$ESCAPED")

rpc "$PAYLOAD"
