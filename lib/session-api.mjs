// lib/session-api.mjs
//
// Everything that touches DSH Session state lives here. The plugin never
// spawns a subagent: it hands a user turn to the target Session through
// `ctx.sessionController.prompt()` (the same Host command the Web GUI's send
// button uses) and then waits for that Session's own `turn/end` event.
//
// Verified against dsh 0.8.6:
//   @deepseek-ai/dsh-api-session-controller/src/index.ts
//     @Remote('prompt') async prompt(request: SessionPromptRequest, signal)
//   @deepseek-ai/dsh-api-session-controller/src/commands.ts
//     async prompt(request, source) { const agent = await this.resolveAgent(...);
//       ... agent.followup(message) | agent.steer(message) }
//   SessionPromptRequest { requestId, sessionId, mode: 'queue'|'steer',
//                          content: PromptContentPart[], clientTimeZone? }
//   SessionPromptValue  { accepted: true }
//
// `@Remote` only attaches discovery metadata (see dsh-typert-protocol
// `remoteDecorator`), so a plain in-process call to the method is supported.

const POLL_MS = 150;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve a Cordis service without making it a hard dependency. */
export function service(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') {
      const found = ctx.get(name);
      if (found !== undefined) return found;
    }
  } catch {
    /* service absent */
  }
  try {
    return ctx ? ctx[name] : undefined;
  } catch {
    return undefined;
  }
}

export function liveAgents(ctx) {
  try {
    const list = ctx && ctx.agents && typeof ctx.agents.list === 'function' ? ctx.agents.list() : [];
    return Array.isArray(list) ? list.filter((a) => a && a.id) : [];
  } catch {
    return [];
  }
}

export function liveSessionIds(ctx) {
  return liveAgents(ctx).map((a) => String(a.id));
}

export function agentOf(ctx, sessionId) {
  try {
    return (ctx.agents && typeof ctx.agents.get === 'function' && ctx.agents.get(sessionId)) || null;
  } catch {
    return null;
  }
}

export function sessionOf(ctx, sessionId) {
  const agent = agentOf(ctx, sessionId);
  if (agent && agent.session) return agent.session;
  try {
    return (ctx.sessions && typeof ctx.sessions.get === 'function' && ctx.sessions.get(sessionId)) || null;
  } catch {
    return null;
  }
}

/** Session event snapshot, newest-host shape first (0.2.x) then 0.1.x.
 *  `from` is a log offset (seq): the host supports `snapshotEvents(from)` so a
 *  long session only materializes the new tail instead of the whole log. */
export function eventsOf(session, from) {
  if (!session) return [];
  try {
    if (typeof session.snapshotEvents === 'function') {
      const events = from === undefined ? session.snapshotEvents() : session.snapshotEvents(from);
      if (Array.isArray(events)) return events;
    }
  } catch {
    /* fall through */
  }
  const all = Array.isArray(session.events) ? session.events : [];
  if (from === undefined) return all;
  return all.filter((event, index) => seqOf(event, index) >= from);
}

function seqOf(event, index) {
  return event && Number.isFinite(event.seq) ? event.seq : index;
}

export function currentSeq(session) {
  if (!session) return 0;
  try {
    if (Number.isFinite(session.seq)) return session.seq;
  } catch {
    /* ignore */
  }
  return eventsOf(session).length;
}

export function cwdOf(ctx, agentOrSession) {
  const session = agentOrSession && agentOrSession.session ? agentOrSession.session : agentOrSession;
  try {
    const wd = service(ctx, 'workingDirectory');
    if (wd && session && typeof wd.get === 'function') {
      const dir = wd.get(session);
      if (typeof dir === 'string' && dir) return dir;
    }
  } catch {
    /* ignore */
  }
  const header = session && session.header;
  return (header && header.cwd) || (session && session.cwd) || null;
}

export function modelOf(ctx, sessionId) {
  const agent = agentOf(ctx, sessionId);
  if (agent && agent.model) {
    try {
      const current = typeof agent.model.current === 'function' ? agent.model.current() : agent.model;
      if (current && typeof current === 'object') {
        if (typeof current.model === 'string') {
          return current.provider ? current.provider + '/' + current.model : current.model;
        }
        if (typeof current.id === 'string') return current.id;
      }
      if (typeof current === 'string') return current;
    } catch {
      /* fall through to event scan */
    }
  }
  // Fallback: newest model route recorded in the session log.
  const events = eventsOf(sessionOf(ctx, sessionId));
  for (let i = events.length - 1; i >= 0; i--) {
    const data = events[i] && events[i].data;
    if (!data) continue;
    const request = data.request || data.llmRequest || {};
    const model = request.model || (data.model && data.model.model) || (typeof data.model === 'string' ? data.model : null);
    if (model) {
      const provider = request.provider || (data.model && data.model.provider);
      return provider ? provider + '/' + model : model;
    }
  }
  return null;
}

export async function readTitle(ctx, sessionId) {
  const query = service(ctx, 'sessionQuery');
  if (!query || typeof query.readTitle !== 'function') return null;
  try {
    const snapshot = await query.readTitle(sessionId);
    if (!snapshot) return null;
    if (typeof snapshot === 'string') return snapshot;
    if (typeof snapshot.title === 'string') return snapshot.title;
    if (snapshot.title && typeof snapshot.title.title === 'string') return snapshot.title.title;
    if (typeof snapshot.value === 'string') return snapshot.value;
    return null;
  } catch {
    return null;
  }
}

export async function readState(ctx, sessionId) {
  const controller = service(ctx, 'sessionController');
  if (!controller || typeof controller.state !== 'function') return null;
  try {
    return await controller.state({ sessionId }, new AbortController().signal);
  } catch {
    return null;
  }
}

/**
 * A live Session is busy only while a turn is actually executing or input is
 * still queued. `state.active` merely means "a live Agent exists", so it must
 * NOT be used here (v0.1 did, which made every live session busy=true).
 *
 * Host source: dsh-api-session-controller/src/state/controller.ts
 *   { cursor: agent.session.seq - 1, active: true,
 *     running: agent.status === 'running', queue: queueItems(agent), ... }
 *   Agent.status = 'running' only outside the idle/maintenance phases.
 */
function busyOf(state) {
  if (!state) return false;
  if (state.running === true) return true;
  return Array.isArray(state.queue) && state.queue.length > 0;
}

/** Live sessions in the requested MCP shape. */
export async function listSessions(ctx) {
  const agents = liveAgents(ctx);
  const rows = [];
  for (const agent of agents) {
    const sessionId = String(agent.id);
    const [state, title] = await Promise.all([readState(ctx, sessionId), readTitle(ctx, sessionId)]);
    rows.push({
      session_id: sessionId,
      title: title,
      model: modelOf(ctx, sessionId),
      cwd: cwdOf(ctx, agent),
      busy: busyOf(state),
    });
  }
  if (rows.length === 0) {
    // No live agents (cold profile): fall back to the passive Session list so
    // the caller can still see candidates.
    const controller = service(ctx, 'sessionController');
    if (controller && typeof controller.list === 'function') {
      try {
        const value = await controller.list({}, new AbortController().signal);
        for (const item of (value && value.items) || []) {
          rows.push({
            session_id: String(item.sessionId),
            title: await readTitle(ctx, String(item.sessionId)),
            model: null,
            cwd: item.cwd || null,
            busy: !!item.running,
          });
        }
      } catch {
        /* ignore */
      }
    }
  }
  return rows;
}

/**
 * Validate a session id without injecting. `sessionController.resolveAgent`
 * returns `{agent}` / `{error}` (it does not throw) and resumes a cold Session,
 * which is exactly what the following prompt would do anyway.
 */
export async function resolveSession(ctx, sessionId) {
  const controller = service(ctx, 'sessionController');
  if (!controller) {
    return { ok: false, reason: 'sessionController service is unavailable in this profile' };
  }
  if (typeof controller.resolveAgent !== 'function') {
    return { ok: false, reason: 'sessionController.resolveAgent is unavailable on this dsh build' };
  }
  try {
    const result = await controller.resolveAgent(sessionId);
    if (result && result.agent) return { ok: true };
    if (result && result.error) {
      const code = result.error.code || 'session/not-found';
      return { ok: false, reason: result.error.message || String(code), code };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error && error.message ? error.message : String(error) };
  }
}

export function newRequestId() {
  const uuid = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return 'dsh-session-inject-' + uuid;
}

/** Submit one user turn into the exact Session. Resolves on admission ack. */
export async function submitPrompt(ctx, sessionId, text, delivery, requestId) {
  const controller = service(ctx, 'sessionController');
  if (!controller || typeof controller.prompt !== 'function') {
    throw new Error('sessionController.prompt is unavailable in this dsh build');
  }
  const mode = delivery === 'steer' ? 'steer' : 'queue';
  let clientTimeZone;
  try {
    clientTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    clientTimeZone = undefined;
  }
  const request = {
    requestId,
    sessionId,
    mode,
    content: [{ type: 'text', text }],
  };
  if (clientTimeZone) request.clientTimeZone = clientTimeZone;
  return controller.prompt(request, new AbortController().signal);
}

function userEventMatches(event, requestId) {
  if (!event) return false;
  if (event.type === 'user/message') {
    const source = event.data && event.data.source;
    return !!source && source.rpcId === requestId;
  }
  if (event.type === 'agent/inbox/spliced') {
    const inserted = (event.data && event.data.inserted) || [];
    return inserted.some((message) => message && message.source && message.source.rpcId === requestId);
  }
  return false;
}

function assistantText(event) {
  const content = event && event.data && event.data.message && event.data.message.content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('');
}

/** Turn-end kinds that mean the turn did NOT complete. */
const FAILED_TURN_KINDS = new Set(['aborted', 'blocked', 'error', 'interrupted']);

/** Structured failure for a `turn/end` reason, or null when the turn completed. */
export function turnEndFailure(turnEnd) {
  const reason = turnEnd && turnEnd.data && turnEnd.data.reason;
  if (!reason || typeof reason.kind !== 'string') return null;
  if (!FAILED_TURN_KINDS.has(reason.kind)) return null;
  return {
    code: 'E_INJECT_FAILED',
    kind: reason.kind,
    message: reason.error && reason.error.message
      ? reason.error.message
      : 'turn ended with reason "' + reason.kind + '"',
    turn_end_reason: reason,
  };
}

function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * Wait until our own user message is admitted and its turn reaches `turn/end`.
 *
 * Incremental (v0.2): `snapshotEvents(cursor)` only materializes events newer
 * than the last one examined, so a 100k-event session costs the same per poll
 * as a fresh one. Pass `options.legacyFullScan = true` to reproduce the v0.1
 * full-array scan for A/B measurements.
 *
 * @returns { user_event, turn_end, last_assistant, reply_text, assistant_texts,
 *            last_event_type, turn_end_reason, failure, event_count,
 *            elapsed_ms, stats:{scans, scan_ms, events_examined}, timed_out? }
 */
export async function waitForTurn(ctx, sessionId, requestId, afterSeq, deadlineMs, options = {}) {
  const started = Date.now();
  const legacyFullScan = options.legacyFullScan === true;
  const stats = { scans: 0, scan_ms: 0, events_examined: 0, legacy_full_scan: legacyFullScan };
  let cursor = afterSeq;
  let anchorSeq = null;
  let lastAssistant = null;
  const assistantTexts = [];
  let lastEventType = null;

  while (Date.now() < deadlineMs) {
    if (typeof options.shouldAbort === 'function' && options.shouldAbort()) throw new Error('submission aborted');
    const session = sessionOf(ctx, sessionId);
    if (session) {
      const scanStarted = now();
      let fresh;
      if (legacyFullScan) {
        fresh = eventsOf(session).filter((event, index) => seqOf(event, index) >= cursor);
      } else {
        fresh = eventsOf(session, cursor);
      }
      stats.scans++;
      stats.scan_ms += now() - scanStarted;
      for (const event of fresh) {
        const seq = event && Number.isFinite(event.seq) ? event.seq : cursor;
        if (seq < cursor) continue;
        stats.events_examined++;
        if (typeof options.onEvent === 'function') {
          try { options.onEvent(event); } catch { /* heartbeat must not break the wait */ }
        }
        if (event && event.type === 'turn/end' && anchorSeq !== null && seq > anchorSeq) {
          const turnEndReason = (event.data && event.data.reason) || null;
          const failure = turnEndFailure(event);
          return {
            user_event: null,
            anchor_seq: anchorSeq,
            turn_end: event,
            last_assistant: lastAssistant,
            reply_text: lastAssistant ? assistantText(lastAssistant) : '',
            assistant_texts: assistantTexts,
            last_event_type: lastEventType,
            turn_end_reason: turnEndReason,
            failure,
            event_count: stats.events_examined,
            elapsed_ms: Date.now() - started,
            stats,
          };
        }
        if (anchorSeq === null) {
          if (userEventMatches(event, requestId)) anchorSeq = seq;
        } else if (event.type === 'assistant/message') {
          lastAssistant = event;
          assistantTexts.push(assistantText(event));
        }
        lastEventType = event.type;
        cursor = Math.max(cursor, seq + 1);
      }
    }
    await sleep(POLL_MS);
  }
  return {
    timed_out: true,
    elapsed_ms: Date.now() - started,
    reply_text: '',
    assistant_texts: assistantTexts,
    last_event_type: lastEventType,
    stats,
  };
}
