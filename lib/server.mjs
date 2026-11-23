// lib/server.mjs
//
// Standalone loopback MCP (JSON-RPC 2.0 over HTTP) endpoint.
//
//   POST /mcp/session-inject   JSON-RPC: initialize | ping | tools/list | tools/call
//   GET  /mcp/session-inject   ping (same payload as the JSON-RPC ping)
//   GET  /health               liveness + counters + store info
//
// v0.3 adds:
//   - maxWaitMs: wait_ms is capped (never an error), response carries
//     wait_capped / requested_ms / effective_ms / submission_id;
//   - submissions_list: find a submission again after losing its id;
//   - phase (queued|running|stalled|done|failed|orphaned) + heartbeat fields;
//   - durable snapshots under <DSH_HOME>/dsh-session-inject/submissions.jsonl,
//     so a dsh restart reports "orphaned" with the last known state instead of
//     "unknown submission_id";
//   - optional MCP progress notifications over an SSE tools/call response when
//     the caller supplies _meta.progressToken.
//
// The transport shape mirrors dsh-hermes-link's /mcp/collab (initialize /
// notifications/initialized / tools/list / tools/call).

import { createServer as createHttpServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

import { createSubmissionStore } from './records.mjs';
import * as api from './session-api.mjs';

export const VERSION = '0.3.0';
export const PROTOCOL_VERSION = '2024-11-05';
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Constant-time string comparison (hash both sides so lengths match). */
function safeEqual(a, b) {
  const left = createHash('sha256').update(String(a)).digest();
  const right = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(left, right);
}

const ErrorCodes = {
  E_AUTH_REQUIRED: { code: -32001, message: 'unauthorized: missing or invalid Authorization: Bearer <token>', hint: 'set DSH_SESSION_INJECT_TOKEN (or config.token) and send the Bearer header' },
  E_UNKNOWN_SESSION: { code: -32030, message: 'unknown session_id', hint: 'call sessions_list and use one of the live session ids' },
  E_INJECT_FAILED: { code: -32031, message: 'session injection failed', hint: 'read the error data; data.submission_id can still be polled with inject_status' },
  E_TIMEOUT: { code: -32032, message: 'timed out waiting for the reply', hint: 'v0.3 returns status=running instead of this error; kept for compatibility only' },
  E_NO_LIVE_SESSION: { code: -32033, message: 'no live DSH session is available', hint: 'open a DSH session first, then call sessions_list' },
  E_UNKNOWN_TOOL: { code: -32601, message: 'unknown tool', hint: 'see tools/list for the supported set' },
  E_UNKNOWN_METHOD: { code: -32601, message: 'unknown method', hint: 'initialize, ping, tools/list, tools/call' },
  E_INVALID_SPEC: { code: -32602, message: 'invalid arguments', hint: 'see the tool inputSchema from tools/list' },
  E_INTERNAL: { code: -32603, message: 'internal error', hint: 'check the dsh host log for the stack trace' },
  E_PARSE_ERROR: { code: -32700, message: 'parse error', hint: 'body must be valid JSON-RPC 2.0' },
  E_INVALID_REQUEST: { code: -32600, message: 'invalid request', hint: 'POST a JSON-RPC 2.0 object to /mcp/session-inject' },
};

export function mcpResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function mcpError(id, codeName, extra, data) {
  const def = ErrorCodes[codeName] || ErrorCodes.E_INTERNAL;
  const base = { error_code: codeName, hint: def.hint };
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: def.code,
      message: extra ? def.message + ': ' + extra : def.message,
      data: data ? Object.assign(base, data) : base,
    },
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function toolResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    metadata: payload,
    isError: false,
  };
}

function toolError(id, codeName, extra, data) {
  return mcpError(id, codeName, extra, data);
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMcpServer(ctx, config = {}, logger = console) {
  const maxWaitMs = Number.isInteger(config.maxWaitMs) ? config.maxWaitMs : 240000;
  const defaultWaitMs = Number.isInteger(config.defaultWaitMs) ? config.defaultWaitMs : 3000;
  const stallMs = Number.isInteger(config.stallMs) ? config.stallMs : 120000;
  const progressIntervalMs = Number.isInteger(config.progressIntervalMs) ? config.progressIntervalMs : 8000;
  const store = createSubmissionStore({
    maxTurnMs: config.maxTurnMs || 10 * 60 * 1000,
    stallMs,
    persistPath: config.persistPath, // undefined = default; null = disable persistence
    ttlMs: config.persistTtlHours ? config.persistTtlHours * 3600 * 1000 : undefined,
  });
  const token = (typeof config.token === 'string' && config.token) || process.env.DSH_SESSION_INJECT_TOKEN || '';
  const host = config.host || '127.0.0.1';
  const port = Number.isInteger(config.port) ? config.port : 3090;
  const startedAt = Date.now();
  const counters = { requests: 0, injections: 0, errors: 0, progress_notifications: 0 };
  const perf = {
    scans: 0,
    scan_ms: 0,
    events_examined: 0,
    legacy_scan: config.legacyScan === true,
  };
  let server = null;
  let listening = null;

  function authorized(req) {
    if (!token) return true;
    const header = (req && (req.headers && req.headers.authorization)) || '';
    const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
    return !!match && safeEqual(match[1], token);
  }

  function summaryOf(record) {
    const summary = store.summarize(record);
    return { ...summary, queue_position: store.queuePositionOf(record) };
  }

  function buildToolsList() {
    const tools = [
      {
        name: 'sessions_list',
        description: 'List the live DSH sessions: session_id, title, model, cwd, busy.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'session_inject',
        description: 'Deliver a user turn INTO one live DSH session (the session itself executes it: its own model, tools and context - no subagent). wait_ms is capped by maxWaitMs (' + maxWaitMs + 'ms); a capped or timed-out wait returns ok:true, status:"running", wait_capped and submission_id - never an error. Poll inject_status/submissions_list for the reply.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', minLength: 1, maxLength: 128, description: 'Target session id; omitted = first live session.' },
            content: { type: 'string', minLength: 1, maxLength: 32000, description: 'Task text delivered as the user turn.' },
            delivery: { type: 'string', enum: ['queue', 'steer'], default: 'queue' },
            wait_ms: { type: 'integer', minimum: 0, maximum: 600000, default: defaultWaitMs, description: 'Requested wait; omitted = ' + defaultWaitMs + 'ms, 0 = return after admission, capped at maxWaitMs (' + maxWaitMs + ').' },
          },
          required: ['content'],
          additionalProperties: false,
        },
      },
      {
        name: 'inject_status',
        description: 'Read one submission by id. Adds phase (queued|running|stalled|done|failed|orphaned), last_activity_at, idle_ms, steps_seen, reply_preview, queue_position. An id from a previous dsh process returns phase="orphaned" with the last persisted state.',
        inputSchema: {
          type: 'object',
          properties: { submission_id: { type: 'string', minLength: 1, maxLength: 128 } },
          required: ['submission_id'],
          additionalProperties: false,
        },
      },
      {
        name: 'submissions_list',
        description: 'List submissions (live + persisted), newest first. Use this to recover a submission when the original call was cut off and its id was lost.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', minLength: 1, maxLength: 128 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
            status: { type: 'string', enum: ['queued', 'running', 'stalled', 'done', 'failed', 'orphaned'] },
          },
          additionalProperties: false,
        },
      },
    ];
    // Registered by default; config.allowCreate: false removes it for locked-down deployments.
    if (config.allowCreate !== false) {
      tools.push({
        name: 'session_create',
        description: 'Create a new blank DSH session and return its id. Optional cwd/agentPreset and provider/model (model is pinned with sessionController.selectModel).',
        inputSchema: {
          type: 'object',
          properties: {
            cwd: { type: 'string', description: 'Working directory for the new session.' },
            agentPreset: { type: 'string', description: 'Agent preset id (default: profile default).' },
            provider: { type: 'string', description: 'LLM provider id to pin.' },
            model: { type: 'string', description: 'Model id to pin (requires provider).' },
          },
          additionalProperties: false,
        },
      });
    }
    return tools;
  }

  async function listSessionsTool(id) {
    const sessions = await api.listSessions(ctx);
    return mcpResult(id, toolResult(sessions));
  }

  /**
   * Admit one user turn. Every branch returns/throws with a submission_id:
   * the record is minted before argument/session validation.
   */
  async function injectTool(id, args, progress) {
    const requested = args.wait_ms === undefined
      ? defaultWaitMs
      : clampInt(args.wait_ms, 0, 600000, 0);
    const effective = Math.min(requested, maxWaitMs);
    const waitCapped = requested > maxWaitMs;
    const content = typeof args.content === 'string' ? args.content : '';
    const delivery = args.delivery === 'steer' ? 'steer' : 'queue';
    const explicit = typeof args.session_id === 'string' && args.session_id.trim() ? args.session_id.trim() : null;

    const record = store.create({
      sessionId: explicit,
      content,
      delivery,
      requestedMs: requested,
      effectiveMs: effective,
      waitCapped,
    });
    const fail = (codeName, extra, data) => {
      counters.errors++;
      store.markFailed(record, extra || codeName);
      return toolError(id, codeName, extra, {
        submission_id: record.submission_id,
        session_id: record.session_id,
        ...data,
      });
    };

    if (!content || content.trim().length === 0) {
      return fail('E_INVALID_SPEC', 'content must be a non-empty string');
    }
    if (content.length > 32000) {
      return fail('E_INVALID_SPEC', 'content exceeds 32000 characters');
    }

    const live = api.liveSessionIds(ctx);
    const sessionId = explicit || live[0] || null;
    if (!sessionId) {
      return fail('E_NO_LIVE_SESSION', 'open a DSH session first (live sessions: none)', { live_sessions: [] });
    }
    record.session_id = sessionId;
    if (explicit) {
      const resolved = await api.resolveSession(ctx, sessionId);
      if (!resolved.ok) {
        return fail(
          'E_UNKNOWN_SESSION',
          'session_id "' + sessionId + '" is not a known DSH session (live sessions: ' + (live.join(', ') || 'none') + ')',
          { live_sessions: live, cause: resolved.reason || null },
        );
      }
    }

    counters.injections++;
    const startedAtMs = Date.now();

    const job = async (rec) => {
      rec.after_seq = api.currentSeq(api.sessionOf(ctx, sessionId));
      rec.request_id = api.newRequestId();
      await api.submitPrompt(ctx, sessionId, content, delivery, rec.request_id);
      rec.admitted = true;
      store.persist(rec);
      const turn = await api.waitForTurn(
        ctx,
        sessionId,
        rec.request_id,
        rec.after_seq,
        Date.now() + store.maxTurnMs,
        {
          legacyFullScan: config.legacyScan === true,
          onEvent: (event) => {
            store.touch(rec, event);
            store.maybePersist(rec, 5000);
          },
        },
      );
      if (turn.stats) {
        perf.scans += turn.stats.scans;
        perf.scan_ms += turn.stats.scan_ms;
        perf.events_examined += turn.stats.events_examined;
      }
      rec.scan_stats = turn.stats || null;
      // `store.touch` already recorded the real last event (turn/end); keep it.
      rec.turn_end_reason = turn.turn_end_reason || null;
      rec.assistant_texts = turn.assistant_texts || [];
      if (turn.timed_out) {
        throw new Error('prompt was admitted but no turn/end was observed within ' + store.maxTurnMs + 'ms');
      }
      if (turn.failure) {
        store.markFailed(rec, turn.failure.message, { failure: turn.failure });
        return;
      }
      rec.reply_text = turn.reply_text;
      rec.turn_end_seq = turn.turn_end && Number.isFinite(turn.turn_end.seq) ? turn.turn_end.seq : null;
      store.markDone(rec);
    };

    // steer inserts into the step already running; it must not wait behind the
    // per-Session queue (that would degrade it to a normal queued turn).
    if (delivery === 'steer') store.runImmediately(record, job);
    else store.run(record, job);

    const graceMs = requested > 0 ? effective : 750;
    const deadline = startedAtMs + graceMs;
    let lastProgressAt = 0;
    for (;;) {
      if (record.status === 'done' || record.status === 'failed') break;
      const now = Date.now();
      if (now >= deadline) break;
      if (progress && requested > 0 && now - lastProgressAt >= progressIntervalMs) {
        lastProgressAt = now;
        counters.progress_notifications++;
        progress({
          phase: store.phaseOf(record),
          elapsed_ms: now - startedAtMs,
          steps_seen: record.steps_seen || 0,
          last_event_type: record.last_event_type || null,
          status: record.status,
          submission_id: record.submission_id,
        });
      }
      await sleep(100);
    }

    const elapsed = Date.now() - startedAtMs;
    if (record.status === 'failed') {
      counters.errors++;
      return toolError(id, 'E_INJECT_FAILED', record.error || 'unknown failure', {
        status: 'failed',
        phase: 'failed',
        submission_id: record.submission_id,
        session_id: sessionId,
        live_sessions: live,
        last_event_type: record.last_event_type || null,
        turn_end_reason: record.turn_end_reason || null,
        ...(record.failure ? { failure: record.failure } : {}),
      });
    }

    const summary = summaryOf(record);
    const payload = {
      ok: true,
      session_id: sessionId,
      submission_id: record.submission_id,
      status: record.status,
      phase: summary.phase,
      wait_capped: waitCapped,
      requested_ms: requested,
      effective_ms: effective,
      elapsed_ms: elapsed,
      steps_seen: record.steps_seen || 0,
      last_event_type: record.last_event_type || null,
      last_activity_at: summary.last_activity_at,
      idle_ms: summary.idle_ms,
      ...(record.status === 'done' ? { reply_text: record.reply_text } : {}),
      ...(record.status === 'done' && record.turn_end_seq !== null ? { turn_end_seq: record.turn_end_seq } : {}),
      ...(record.turn_end_reason ? { turn_end_reason: record.turn_end_reason } : {}),
      ...(record.assistant_texts ? { assistant_texts: record.assistant_texts } : {}),
    };
    return mcpResult(id, toolResult(payload));
  }

  function injectStatusTool(id, args) {
    const submissionId = typeof args.submission_id === 'string' ? args.submission_id.trim() : '';
    if (!submissionId) {
      return toolError(id, 'E_INVALID_SPEC', 'submission_id is required');
    }
    const record = store.get(submissionId) || store.getPersisted(submissionId);
    if (!record) {
      return toolError(id, 'E_INVALID_SPEC', 'unknown submission_id "' + submissionId + '"', {
        submission_id: submissionId,
      });
    }
    const summary = summaryOf(record);
    const payload = {
      ...summary,
      ...(record.status === 'done' ? { reply_text: record.reply_text } : {}),
      ...(record.status === 'failed' ? { error: record.error } : {}),
      ...(record.turn_end_seq !== null && record.turn_end_seq !== undefined ? { turn_end_seq: record.turn_end_seq } : {}),
      ...(record.turn_end_reason ? { turn_end_reason: record.turn_end_reason } : {}),
      ...(record.assistant_texts ? { assistant_texts: record.assistant_texts } : {}),
      ...(record.failure ? { failure: record.failure } : {}),
    };
    if (record.orphaned) payload.orphaned = true;
    return mcpResult(id, toolResult(payload));
  }

  function submissionsListTool(id, args) {
    const sessionId = typeof args.session_id === 'string' && args.session_id.trim() ? args.session_id.trim() : undefined;
    const limit = clampInt(args.limit, 1, 100, 10);
    const status = typeof args.status === 'string' && args.status.trim() ? args.status.trim() : undefined;
    const rows = store.list({ sessionId, limit, status });
    return mcpResult(id, toolResult(rows));
  }

  async function createSessionTool(id, args) {
    const controller = api.service(ctx, 'sessionController');
    if (!controller || typeof controller.create !== 'function') {
      return toolError(id, 'E_INTERNAL', 'sessionController.create is unavailable');
    }
    try {
      const request = {};
      if (typeof args.cwd === 'string' && args.cwd) request.cwd = args.cwd;
      if (typeof args.agentPreset === 'string' && args.agentPreset) request.agentPreset = args.agentPreset;
      const created = await controller.create(request);
      if (args.provider && args.model && typeof controller.selectModel === 'function') {
        await controller.selectModel({ sessionId: created.sessionId, provider: args.provider, model: args.model });
      }
      return mcpResult(id, toolResult({ ok: true, session_id: created.sessionId }));
    } catch (error) {
      return toolError(id, 'E_INJECT_FAILED', error && error.message ? error.message : String(error));
    }
  }

  async function handleRpc(body, options = {}) {
    counters.requests++;
    const id = body && body.id !== undefined ? body.id : null;
    const method = body && body.method;
    const params = body && body.params;
    try {
      if (method === 'initialize') {
        return mcpResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'dsh-session-inject', version: VERSION },
        });
      }
      if (method === 'ping') {
        return mcpResult(id, {
          ok: true,
          version: VERSION,
          profile: process.env.DSH_PROFILE || null,
          live_sessions: api.liveSessionIds(ctx),
          submissions: { live: store.records.size, persisted: store.persisted.size },
          counters,
          uptime_ms: Date.now() - startedAt,
        });
      }
      if (method === 'notifications/initialized') return null;
      if (method === 'tools/list') return mcpResult(id, { tools: buildToolsList() });
      if (method === 'tools/call') {
        const name = params && params.name;
        const args = (params && params.arguments) || {};
        if (name === 'sessions_list') return await listSessionsTool(id);
        if (name === 'session_inject') return await injectTool(id, args, options.progress);
        if (name === 'inject_status') return injectStatusTool(id, args);
        if (name === 'submissions_list') return submissionsListTool(id, args);
        if (name === 'session_create' && config.allowCreate !== false) return await createSessionTool(id, args);
        return toolError(id, 'E_UNKNOWN_TOOL', String(name));
      }
      return toolError(id, 'E_UNKNOWN_METHOD', String(method));
    } catch (error) {
      counters.errors++;
      return toolError(id, 'E_INTERNAL', error && error.message ? error.message : String(error));
    }
  }

  /** POST a tools/call with _meta.progressToken over an SSE response. */
  async function handleSseToolCall(res, body) {
    const tokenValue = body.params._meta.progressToken;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    let seq = 0;
    const send = (message) => {
      if (res.writableEnded) return;
      res.write('event: message\ndata: ' + JSON.stringify(message) + '\n\n');
    };
    const progress = (snapshot) => {
      seq += 1;
      send({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: {
          progressToken: tokenValue,
          progress: seq,
          total: 100,
          message: JSON.stringify(snapshot),
        },
      });
    };
    try {
      const out = await handleRpc(body, { progress });
      if (out !== null) send(out);
    } catch (error) {
      send(mcpError(body && body.id, 'E_INTERNAL', error && error.message ? error.message : String(error)));
    } finally {
      res.end();
    }
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url || '/', 'http://' + host + ':' + port);
    if (url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        version: VERSION,
        host,
        port,
        auth: token ? 'bearer-required' : 'open',
        live_sessions: api.liveSessionIds(ctx),
        counters,
        store: {
          live: store.records.size,
          persisted: store.persisted.size,
          persist_path: store.persistPath,
          stall_ms: store.stallMs,
          max_wait_ms: maxWaitMs,
        },
        perf: {
          ...perf,
          scan_ms_avg: perf.scans > 0 ? Math.round((perf.scan_ms / perf.scans) * 100) / 100 : 0,
        },
        uptime_ms: Date.now() - startedAt,
      });
    }
    if (url.pathname !== '/mcp/session-inject') {
      return json(res, 404, { error: 'not found', path: url.pathname });
    }
    if (!authorized(req)) return json(res, 401, mcpError(null, 'E_AUTH_REQUIRED', null, null));

    const method = (req.method || 'GET').toUpperCase();
    if (method === 'GET') {
      return json(res, 200, mcpResult(0, {
        ok: true,
        version: VERSION,
        live_sessions: api.liveSessionIds(ctx),
      }));
    }
    if (method !== 'POST') {
      return json(res, 405, mcpError(null, 'E_INVALID_REQUEST', 'method not allowed: ' + method));
    }
    let body;
    try {
      const raw = await readBody(req);
      if (!raw) return json(res, 400, mcpError(null, 'E_INVALID_REQUEST', 'missing body'));
      body = JSON.parse(raw);
    } catch (error) {
      return json(res, 400, mcpError(null, 'E_PARSE_ERROR', error.message));
    }

    const progressToken = body && body.method === 'tools/call' && body.params && body.params._meta
      ? body.params._meta.progressToken
      : undefined;
    const wantsSse = progressToken !== undefined
      && /text\/event-stream/i.test(String((req.headers && req.headers.accept) || ''));
    if (wantsSse) return handleSseToolCall(res, body);

    const out = await handleRpc(body);
    if (out === null) {
      res.writeHead(204);
      return res.end();
    }
    return json(res, 200, out);
  }

  function start() {
    if (server) return listening;
    server = createHttpServer((req, res) => {
      handleRequest(req, res).catch((error) => {
        try {
          json(res, 500, mcpError(null, 'E_INTERNAL', error && error.message ? error.message : String(error)));
        } catch {
          /* socket already gone */
        }
      });
    });
    listening = new Promise((resolve, reject) => {
      server.once('error', (error) => {
        logger.error('[dsh-session-inject] HTTP server failed on ' + host + ':' + port + ': ' + (error && error.message ? error.message : error));
        reject(error);
      });
      server.listen(port, host, () => {
        logger.log('[dsh-session-inject] listening on http://' + host + ':' + port + '/mcp/session-inject (health: /health)');
        resolve({ host, port });
      });
    });
    return listening;
  }

  function close() {
    if (!server) return;
    try {
      server.close();
    } catch {
      /* ignore */
    }
    server = null;
    listening = null;
  }

  return { start, close, handleRpc, store, counters, perf, get address() { return { host, port }; } };
}
