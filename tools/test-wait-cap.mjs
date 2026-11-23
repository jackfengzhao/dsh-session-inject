#!/usr/bin/env node
// Acceptance A: wait_ms=600000 must be capped at maxWaitMs (240000) and return
// ok:true / status:"running" / wait_capped:true / submission_id - never an error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'docs', 'evidence');
const url = process.env.DSH_SESSION_INJECT_URL || 'http://127.0.0.1:3090/mcp/session-inject';
const sessionId = process.argv[2];
if (!sessionId) {
  console.error('usage: node tools/test-wait-cap.mjs <session-id>');
  process.exit(1);
}

const started = Date.now();
const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'session_inject',
      arguments: {
        session_id: sessionId,
        content: '请调用 pwsh 工具执行 `Start-Sleep -Seconds 280`，命令结束后只回复 CAP-DONE，不要解释。',
        delivery: 'queue',
        wait_ms: 600000,
      },
    },
  }),
});
const wallMs = Date.now() - started;
const rpc = await res.json();
const payload = rpc.result ? JSON.parse(rpc.result.content[0].text) : null;

const evidence = {
  captured_at: new Date().toISOString(),
  session_id: sessionId,
  requested_wait_ms: 600000,
  wall_ms: wallMs,
  http_status: res.status,
  payload,
  error: rpc.error || null,
  checks: {
    http_200: res.status === 200,
    no_error: !rpc.error,
    status_running: payload && payload.status === 'running',
    wait_capped: payload && payload.wait_capped === true,
    requested_ms: payload && payload.requested_ms === 600000,
    effective_ms: payload && payload.effective_ms === 240000,
    has_submission_id: !!(payload && payload.submission_id),
    wall_close_to_cap: wallMs >= 235000 && wallMs <= 260000,
  },
};
fs.writeFileSync(path.join(dir, '3x-wait-cap.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(evidence, null, 2));
process.exit(Object.values(evidence.checks).every(Boolean) ? 0 : 1);
