#!/usr/bin/env node
// End-to-end smoke test for dsh-session-inject.
// Usage:
//   node tools/smoke.mjs [session-id] [url]
// When session-id is omitted the first live session is used.
const target = process.argv[2] || null;
const url = process.argv[3] || 'http://127.0.0.1:3090/mcp/session-inject';

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

const report = { checks: {}, details: {} };
const startedAt = new Date().toISOString();

const tools = await rpc('tools/list', {});
report.checks.tools_list = Array.isArray(tools?.result?.tools) && tools.result.tools.length >= 3;
report.details.tools = tools?.result?.tools?.map((t) => t.name) || [];

const list = await call('sessions_list', {});
const listed = payload(list);
const sessions = Array.isArray(listed) ? listed : (listed?.sessions || []);
report.checks.sessions_list = sessions.length > 0;
report.details.sessions = sessions;
const sessionId = target || sessions[0]?.session_id || null;
report.details.target = sessionId;

const unknown = await call('session_inject', { session_id: 'session-does-not-exist-0000', content: 'ping' });
report.checks.unknown_session = unknown?.error?.data?.error_code === 'E_UNKNOWN_SESSION'
  && Array.isArray(unknown?.error?.data?.live_sessions);
report.details.unknown_session = unknown;

let inject = null;
if (sessionId) {
  inject = await call('session_inject', { session_id: sessionId, content: '请只回复 SMOKE-OK', delivery: 'queue', wait_ms: 180000 });
  const body = payload(inject);
  report.checks.inject_done = body?.status === 'done' && typeof body?.reply_text === 'string' && body.reply_text.includes('SMOKE-OK');
  report.details.inject = body;
  if (body?.submission_id) {
    const status = await call('inject_status', { submission_id: body.submission_id });
    report.details.inject_status = payload(status);
    report.checks.inject_status = payload(status)?.status === 'done';
  }
}

const passed = Object.values(report.checks).every(Boolean);
console.log(JSON.stringify({ started_at: startedAt, finished_at: new Date().toISOString(), passed, report }, null, 2));
process.exit(passed ? 0 : 1);
