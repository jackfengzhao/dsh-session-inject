#!/usr/bin/env node
// Acceptance B: the caller's HTTP request is cut at 5s (curl --max-time 5).
// Recover the submission through submissions_list and follow inject_status to done.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'docs', 'evidence');
const url = process.env.DSH_SESSION_INJECT_URL || 'http://127.0.0.1:3090/mcp/session-inject';
const sessionId = process.argv[2];
const curlExit = process.argv[3] || 'unknown';
if (!sessionId) {
  console.error('usage: node tools/test-recover.mjs <session-id> [curl-exit]');
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

const listed = payload(await call('submissions_list', { session_id: sessionId, limit: 5 }));
const rows = Array.isArray(listed) ? listed : (listed?.submissions || []);
const target = rows.find((row) => row.status === 'running' || row.status === 'queued' || row.phase === 'stalled')
  || rows[0];
if (!target) {
  console.error('submissions_list returned nothing for ' + sessionId + ': ' + JSON.stringify(listed));
  process.exit(1);
}

const timeline = [];
let final = null;
const started = Date.now();
while (Date.now() - started < 180000) {
  const status = payload(await call('inject_status', { submission_id: target.submission_id }));
  if (!status) break;
  timeline.push({ at_ms: Date.now() - started, status: status.status, phase: status.phase, idle_ms: status.idle_ms, steps_seen: status.steps_seen });
  if (status.status === 'done' || status.status === 'failed') { final = status; break; }
  await sleep(3000);
}

const evidence = {
  captured_at: new Date().toISOString(),
  session_id: sessionId,
  curl_exit: curlExit,
  recovered_from_list: target,
  timeline,
  final_status: final,
  checks: {
    list_found_running: target.status === 'running' || target.phase === 'stalled' || target.phase === 'queued',
    reached_done: final ? final.status === 'done' : false,
    reply_correct: final ? String(final.reply_text || '').includes('B-DONE') : false,
  },
};
fs.writeFileSync(path.join(dir, '3x-disconnect.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ checks: evidence.checks, recovered: target, final: final && { status: final.status, reply_text: final.reply_text } }, null, 2));
process.exit(Object.values(evidence.checks).every(Boolean) ? 0 : 1);
