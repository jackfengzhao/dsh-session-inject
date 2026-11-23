#!/usr/bin/env node
// Acceptance test E: two concurrent injections into the same Session.
// The per-Session serial queue must keep them apart: the second stays
// `queued` while the first runs, and each reply belongs to its own prompt.
//
// Usage: node tools/test-concurrent.mjs <session-id> [url]
const sessionId = process.argv[2];
const url = process.argv[3] || 'http://127.0.0.1:3090/mcp/session-inject';
if (!sessionId) {
  console.error('usage: node tools/test-concurrent.mjs <session-id> [url]');
  process.exit(1);
}

let id = 100;
async function call(name, args) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }),
  });
  return res.json();
}

const prompts = [
  { tag: 'CONC-A', text: '只回复 CONC-A，不要解释。' },
  { tag: 'CONC-B', text: '只回复 CONC-B，不要解释。' },
];

const started = Date.now();
const pending = prompts.map((p) => call('session_inject', {
  session_id: sessionId,
  content: p.text,
  delivery: 'queue',
  wait_ms: 180000,
}).then((r) => ({ tag: p.tag, elapsed_ms: Date.now() - started, response: r })));

const results = await Promise.all(pending);
for (const row of results) {
  console.log(JSON.stringify({ tag: row.tag, elapsed_ms: row.elapsed_ms, response: row.response }, null, 2));
}
