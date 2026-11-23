#!/usr/bin/env node
// Official MCP SDK compatibility check for dsh-session-inject.
//
// Runs the real Streamable HTTP handshake:
//   initialize -> notifications/initialized -> tools/list -> tools/call
//
// Usage:
//   node tools/mcp-client-check.mjs [url] [session-id]
// Env:
//   DSH_SESSION_INJECT_TOKEN  optional bearer token
//
// Writes the captured transcript to docs/evidence/2x-mcp-client.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const evidenceDir = path.join(here, '..', 'docs', 'evidence');
fs.mkdirSync(evidenceDir, { recursive: true });

const url = process.argv[2] || 'http://127.0.0.1:3090/mcp/session-inject';
const sessionId = process.argv[3] || 'session-3e2b7ded-74fb-4fea-803d-0cbc0d81e344';
const token = process.env.DSH_SESSION_INJECT_TOKEN || '';

const captured = {
  started_at: new Date().toISOString(),
  url,
  sdk: null,
  handshake: {},
  tools: null,
  calls: {},
  ok: false,
};

async function readSdkVersion() {
  try {
    const pkgPath = path.join(here, '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version;
  } catch {
    return null;
  }
}

const client = new Client(
  { name: 'dsh-session-inject-verify', version: '0.2.0' },
  { capabilities: {} },
);

client.onerror = (error) => {
  captured.handshake.client_error = String(error && error.message ? error.message : error);
};

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: token ? { headers: { authorization: 'Bearer ' + token } } : {},
});

try {
  captured.sdk = await readSdkVersion();
  await client.connect(transport);
  captured.handshake.initialize = 'ok';
  captured.handshake.server = transport.protocolVersion || null;

  const tools = await client.listTools();
  captured.tools = tools;
  captured.handshake.tools_list = (tools.tools || []).map((tool) => tool.name);

  const list = await client.callTool({ name: 'sessions_list', arguments: {} });
  captured.calls.sessions_list = {
    isError: list.isError === true,
    content_types: (list.content || []).map((item) => item.type),
    text: (list.content || []).find((item) => item.type === 'text')?.text || null,
  };

  const inject = await client.callTool({
    name: 'session_inject',
    arguments: {
      session_id: sessionId,
      content: '只回复 MCP-SDK-OK，不要解释。',
      delivery: 'queue',
      wait_ms: 120000,
    },
  });
  captured.calls.session_inject = {
    isError: inject.isError === true,
    content_types: (inject.content || []).map((item) => item.type),
    text: (inject.content || []).find((item) => item.type === 'text')?.text || null,
  };

  const parsed = (() => {
    try { return JSON.parse(captured.calls.session_inject.text || 'null'); } catch { return null; }
  })();
  if (parsed && parsed.submission_id) {
    const status = await client.callTool({
      name: 'inject_status',
      arguments: { submission_id: parsed.submission_id },
    });
    captured.calls.inject_status = {
      isError: status.isError === true,
      content_types: (status.content || []).map((item) => item.type),
      text: (status.content || []).find((item) => item.type === 'text')?.text || null,
    };
  }

  captured.ok = captured.handshake.initialize === 'ok'
    && Array.isArray(captured.tools?.tools)
    && captured.tools.tools.length >= 3
    && captured.calls.sessions_list.isError === false
    && captured.calls.session_inject.isError === false
    && /"status": "done"/.test(captured.calls.session_inject.text || '');
} catch (error) {
  captured.error = String(error && error.stack ? error.stack : error);
} finally {
  try { await client.close(); } catch { /* already closed */ }
  captured.finished_at = new Date().toISOString();
  const outPath = path.join(evidenceDir, '2x-mcp-client.json');
  fs.writeFileSync(outPath, JSON.stringify(captured, null, 2) + '\n', 'utf8');
  process.stdout.write(JSON.stringify(captured, null, 2) + '\n');
  process.exit(captured.ok ? 0 : 1);
}
