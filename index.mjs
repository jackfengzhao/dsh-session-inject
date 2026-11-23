// dsh-session-inject
//
// A DSH Host plugin that exposes a small MCP (JSON-RPC 2.0 / HTTP) endpoint so
// an external agent (Hermes) can:
//   1. list live DSH sessions,
//   2. deliver a user turn INTO an exact Session (the Session itself executes
//      it - no subagent is spawned),
//   3. read back that turn's final reply.
//
// It does not modify or depend on dsh-hermes-link; the two plugins can run in
// the same profile side by side.
//
// Register in a profile with the bundle patch:
//   - insert:
//       - id: dsh-session-inject
//         name: 'dsh-session-inject'
//         config: { port: 3090, host: '127.0.0.1' }

import { createMcpServer } from './lib/server.mjs';

export const name = 'dsh-session-inject';

// Core Host services used by the injection path. sessionController is looked
// up lazily (ctx.get) so a profile without it still starts the endpoint and
// reports a structured error instead of silently failing to load.
export const inject = ['agents', 'sessions'];

export function apply(ctx, config = {}) {
  const server = createMcpServer(ctx, config || {}, console);

  server.start().catch(() => {
    // start() already logged the reason (e.g. EADDRINUSE); keep the Host alive.
  });

  const dispose = () => server.close();
  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => dispose, 'dsh-session-inject.http');
      return;
    }
  } catch {
    /* fall through to dispose event */
  }
  try {
    if (typeof ctx.on === 'function') ctx.on('dispose', dispose);
  } catch {
    /* nothing else to do */
  }
}
