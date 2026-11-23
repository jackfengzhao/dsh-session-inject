#!/usr/bin/env node
// Test-only OpenAI-compatible endpoint that always answers 401.
// Used to prove that an LLM authentication failure turns into status=failed.
// Usage: node tools/fake-401-server.mjs [port]
import { createServer } from 'node:http';

const port = Number(process.argv[2] || 3091);
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const payload = JSON.stringify({
      error: {
        message: 'invalid api key (dsh-session-inject v0.2 test fixture)',
        type: 'authentication_error',
        code: 'invalid_api_key',
      },
    });
    res.writeHead(401, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
    console.log('[fake-401] ' + new Date().toISOString() + ' ' + req.method + ' ' + req.url + ' -> 401');
  });
});
server.listen(port, '127.0.0.1', () => {
  console.log('[fake-401] listening on http://127.0.0.1:' + port);
});
