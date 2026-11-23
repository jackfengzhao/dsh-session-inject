#!/usr/bin/env node
// v0.2 evidence capture: tool list, busy flags, session_create + inject round trip.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'docs', 'evidence');
fs.mkdirSync(dir, { recursive: true });
const url = 'http://127.0.0.1:3090/mcp/session-inject';
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
  try { return JSON.parse(text); } catch { return null; }
}
function save(name, value) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
}
const capturedAt = new Date().toISOString();

const tools = await rpc('tools/list', {});
save('2x-tools-list.json', {
  captured_at: capturedAt,
  tools: (tools.result?.tools || []).map((tool) => tool.name),
  raw: tools,
});

const list = await call('sessions_list', {});
const sessions = payload(list) || [];
save('2x-busy.json', {
  captured_at: capturedAt,
  note: 'v0.1 busyOf() used state.active, so every live session was true; v0.2 uses state.running || queue.length.',
  before_v0_1: { source: 'docs/evidence/03-sessions-list.json', values: 'all four sessions busy=true' },
  after_v0_2: sessions.map((row) => ({ session_id: row.session_id, title: row.title, busy: row.busy })),
  raw: list,
});

const created = await call('session_create', {
  cwd: 'C:\\Users\\<user>\\Documents\\code\\dsh-session-inject\\test-workspace',
  provider: process.env.CAPTURE_PROVIDER || '<provider>',
  model: 'mimo-v2.6-flash',
});
const createdPayload = payload(created);
save('2x-session-create.json', {
  captured_at: new Date().toISOString(),
  tool: 'session_create',
  response: created,
  parsed: createdPayload,
});

if (createdPayload?.session_id) {
  const inject = await call('session_inject', {
    session_id: createdPayload.session_id,
    content: '只回复 CREATE-OK，不要解释。',
    delivery: 'queue',
    wait_ms: 120000,
  });
  const injected = payload(inject);
  const status = injected?.submission_id
    ? await call('inject_status', { submission_id: injected.submission_id })
    : null;
  save('2x-create-inject.json', {
    captured_at: new Date().toISOString(),
    session_id: createdPayload.session_id,
    inject: { response: inject, parsed: injected },
    status: status ? { response: status, parsed: payload(status) } : null,
  });
}

console.log(JSON.stringify({ ok: true, captured_at: capturedAt, evidence_dir: dir }, null, 2));
