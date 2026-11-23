#!/usr/bin/env node
// Acceptance E: official MCP SDK client receives >=2 notifications/progress
// while a session_inject call is waiting.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'docs', 'evidence');
const url = process.env.DSH_SESSION_INJECT_URL || 'http://127.0.0.1:3090/mcp/session-inject';
const sessionId = process.argv[2];
if (!sessionId) {
  console.error('usage: node tools/test-progress.mjs <session-id>');
  process.exit(1);
}

const sdkVersion = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(here, '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), 'utf8')).version;
  } catch { return null; }
})();

const progress = [];
const client = new Client({ name: 'dsh-session-inject-progress', version: '0.3.0' }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(url));
const started = Date.now();

let result = null;
let error = null;
try {
  await client.connect(transport);
  result = await client.callTool(
    {
      name: 'session_inject',
      arguments: {
        session_id: sessionId,
        content: '请写一篇约 900 字的中文文章，主题是「MCP 进度通知的设计」。不要使用任何工具，直接输出正文。',
        delivery: 'queue',
        wait_ms: 120000,
      },
    },
    undefined,
    {
      onprogress: (p) => {
        progress.push({
          at_ms: Date.now() - started,
          progress: p.progress,
          total: p.total,
          message: p.message,
        });
      },
    },
  );
} catch (e) {
  error = String(e && e.stack ? e.stack : e);
} finally {
  try { await client.close(); } catch { /* ignore */ }
}

const text = result?.content?.find((item) => item.type === 'text')?.text || null;
const payload = (() => { try { return JSON.parse(text); } catch { return null; } })();

const evidence = {
  captured_at: new Date().toISOString(),
  session_id: sessionId,
  sdk: sdkVersion,
  wall_ms: Date.now() - started,
  progress_count: progress.length,
  progress,
  result: { isError: result?.isError === true, payload },
  error,
  checks: {
    received_two_or_more: progress.length >= 2,
    call_succeeded: payload?.status === 'done',
    reply_present: typeof payload?.reply_text === 'string' && payload.reply_text.length > 0,
  },
};
fs.writeFileSync(path.join(dir, '3x-progress.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ checks: evidence.checks, progress_count: evidence.progress_count, sdk: evidence.sdk, first: progress[0], last: progress[progress.length - 1] }, null, 2));
process.exit(Object.values(evidence.checks).every(Boolean) ? 0 : 1);
