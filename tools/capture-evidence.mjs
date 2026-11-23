#!/usr/bin/env node
// Capture live acceptance evidence into docs/evidence/*.json.
// Usage: node tools/capture-evidence.mjs [session-id] [url]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'docs', 'evidence');
fs.mkdirSync(outDir, { recursive: true });

const url = process.argv[3] || 'http://127.0.0.1:3090/mcp/session-inject';
const healthUrl = url.replace(/\/mcp\/session-inject$/, '/health');
let nextId = 1;
async function rpc(method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  return res.json();
}
async function call(name, args) {
  return rpc('tools/call', { name, arguments: args });
}
function payload(response) {
  const text = response?.result?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return null; }
}
function save(name, value) {
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
}

const capturedAt = new Date().toISOString();
const health = await (await fetch(healthUrl)).json();
save('01-health.json', { captured_at: capturedAt, health });

const tools = await rpc('tools/list', {});
save('02-tools-list.json', { captured_at: capturedAt, tools });

const sessions = await call('sessions_list', {});
save('03-sessions-list.json', { captured_at: capturedAt, sessions });

const target = process.argv[2] || (Array.isArray(payload(sessions)) ? payload(sessions)[0]?.session_id : payload(sessions)?.sessions?.[0]?.session_id);
if (!target) {
  console.error('no live session; cannot continue');
  process.exit(1);
}

const tag = 'EVID-' + Date.now().toString(36).toUpperCase();
const inject = await call('session_inject', {
  session_id: target,
  content: '只回复 ' + tag + '，不要解释。',
  delivery: 'queue',
  wait_ms: 180000,
});
save('04-inject.json', { captured_at: new Date().toISOString(), requested_tag: tag, response: inject, parsed: payload(inject) });

const body = payload(inject);
if (body?.submission_id) {
  const status = await call('inject_status', { submission_id: body.submission_id });
  save('05-inject-status.json', { captured_at: new Date().toISOString(), response: status, parsed: payload(status) });
}

const unknown = await call('session_inject', { session_id: 'session-does-not-exist-0000', content: 'ping', wait_ms: 1000 });
save('06-unknown-session.json', { captured_at: new Date().toISOString(), response: unknown });

const concurrentStarted = Date.now();
const [a, b] = await Promise.all([
  call('session_inject', { session_id: target, content: '只回复 CONC-A，不要解释。', delivery: 'queue', wait_ms: 180000 }),
  call('session_inject', { session_id: target, content: '只回复 CONC-B，不要解释。', delivery: 'queue', wait_ms: 180000 }),
]);
save('07-concurrent.json', {
  captured_at: new Date().toISOString(),
  elapsed_ms: Date.now() - concurrentStarted,
  a: { response: a, parsed: payload(a) },
  b: { response: b, parsed: payload(b) },
});

console.log(JSON.stringify({ ok: true, target, tag, evidence_dir: outDir, injected: payload(inject) }, null, 2));
