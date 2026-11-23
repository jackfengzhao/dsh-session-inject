#!/usr/bin/env node
// Tiny CLI for manual/edge tests against a running dsh-session-inject server.
// Usage:
//   node tools/inject.mjs <session-id> "<content>" [wait_ms] [delivery]
// Env: DSH_SESSION_INJECT_URL, DSH_SESSION_INJECT_TOKEN
const sid = process.argv[2];
const content = process.argv[3];
const waitMs = Number(process.argv[4] || 120000);
const delivery = process.argv[5] || 'queue';
const url = process.env.DSH_SESSION_INJECT_URL || 'http://127.0.0.1:3090/mcp/session-inject';
if (!sid || !content) {
  console.error('usage: node tools/inject.mjs <session-id> "<content>" [wait_ms] [delivery]');
  process.exit(1);
}
const headers = { 'content-type': 'application/json' };
if (process.env.DSH_SESSION_INJECT_TOKEN) headers.authorization = 'Bearer ' + process.env.DSH_SESSION_INJECT_TOKEN;
const res = await fetch(url, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'session_inject', arguments: { session_id: sid, content, delivery, wait_ms: waitMs } },
  }),
});
const body = await res.json();
process.stdout.write(JSON.stringify({ http_status: res.status, response: body }, null, 2) + '\n');
