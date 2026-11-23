#!/usr/bin/env node
// v0.2 steer test: start a long turn (queue, wait_ms=0), then steer into it.
// Verifies the steer is admitted while the turn is running and that its reply
// belongs to that (shared) turn.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'docs', 'evidence');
const url = 'http://127.0.0.1:3090/mcp/session-inject';
const sessionId = process.argv[2];
if (!sessionId) {
  console.error('usage: node tools/test-steer.mjs <session-id>');
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

const first = await call('session_inject', {
  session_id: sessionId,
  content: '请写一篇约 1200 字的中文文章，主题是「会话注入插件的设计」。不要使用任何工具，直接输出正文。',
  delivery: 'queue',
  wait_ms: 0,
});
const firstParsed = payload(first);
const firstAt = Date.now();

await sleep(2500);

const steer = await call('session_inject', {
  session_id: sessionId,
  content: '补充要求：文章最后单独一行只写 STEER-OK。',
  delivery: 'steer',
  wait_ms: 180000,
});
const steerParsed = payload(steer);
const steerAt = Date.now();

let firstStatus = null;
if (firstParsed?.submission_id) {
  await sleep(1000);
  firstStatus = await call('inject_status', { submission_id: firstParsed.submission_id });
}

const evidence = {
  captured_at: new Date().toISOString(),
  session_id: sessionId,
  queue_submission: { sent_at_ms: firstAt, response: firstParsed },
  steer_submission: { sent_at_ms: steerAt, after_ms: steerAt - firstAt, response: steerParsed },
  queue_status: payload(firstStatus),
  checks: {
    steer_admitted_while_running: steerParsed?.status === 'done',
    steer_text_visible_in_reply: typeof steerParsed?.reply_text === 'string' && steerParsed.reply_text.includes('STEER-OK'),
    queue_submission_done: payload(firstStatus)?.status === 'done',
  },
};
fs.writeFileSync(path.join(dir, '2x-steer.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(evidence, null, 2));
