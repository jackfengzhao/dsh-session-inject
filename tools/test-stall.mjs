#!/usr/bin/env node
// Acceptance C: a turn with no Session events for >stallMs shows
// phase="stalled" (not failed), then recovers to done when it finishes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'docs', 'evidence');
const url = process.env.DSH_SESSION_INJECT_URL || 'http://127.0.0.1:3090/mcp/session-inject';
const sessionId = process.argv[2];
if (!sessionId) {
  console.error('usage: node tools/test-stall.mjs <session-id>');
  process.exit(1);
}

let nextId = 1;
async function call(name, args) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  return res.json();
}
function payload(response) {
  const text = response?.result?.content?.[0]?.text;
  try { return JSON.parse(text); } catch { return null; }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const injected = payload(await call('session_inject', {
  session_id: sessionId,
  content: '请调用 pwsh 工具执行 `Start-Sleep -Seconds 150`，命令结束后只回复 STALL-DONE，不要解释。',
  delivery: 'queue',
  wait_ms: 0,
}));

const submissionId = injected?.submission_id;
if (!submissionId) {
  console.error('no submission id: ' + JSON.stringify(injected));
  process.exit(1);
}

const timeline = [];
let stalled = null;
let done = null;
const started = Date.now();
while (Date.now() - started < 300000) {
  const status = payload(await call('inject_status', { submission_id: submissionId }));
  if (!status) break;
  timeline.push({
    at_ms: Date.now() - started,
    status: status.status,
    phase: status.phase,
    idle_ms: status.idle_ms,
    steps_seen: status.steps_seen,
    last_event_type: status.last_event_type,
  });
  if (status.phase === 'stalled' && !stalled) stalled = status;
  if (status.status === 'done' || status.status === 'failed') { done = status; break; }
  await sleep(10000);
}

const evidence = {
  captured_at: new Date().toISOString(),
  session_id: sessionId,
  submission_id: submissionId,
  inject_response: injected,
  stalled_snapshot: stalled,
  final_status: done,
  timeline,
  checks: {
    stalled_observed: !!stalled,
    idle_over_stall: stalled ? stalled.idle_ms > 120000 : false,
    not_failed_while_stalled: stalled ? stalled.status === 'running' : false,
    recovered_done: done ? done.status === 'done' : false,
  },
};
fs.writeFileSync(path.join(dir, '3x-stall.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ checks: evidence.checks, stalled: stalled && { at: stalled.last_activity_at, idle_ms: stalled.idle_ms }, final: done && done.status }, null, 2));
process.exit(Object.values(evidence.checks).every(Boolean) ? 0 : 1);
