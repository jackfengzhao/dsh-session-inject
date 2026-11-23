// lib/records.mjs
//
// Submission registry with three additions over v0.2:
//   1. a *phase* view (queued | running | stalled | done | failed | orphaned)
//      derived from the record plus the time of the last observed Session event;
//   2. durable snapshots appended to <DSH_HOME>/dsh-session-inject/submissions.jsonl
//      so a dsh restart does not turn a known submission into "unknown";
//   3. a merged list() (live + persisted) used by submissions_list.
//
// Statuses (durable): queued -> running -> done | failed.
// Phase (derived at read time):
//   queued   waiting behind another submission for the same Session
//   running  prompt admitted and the turn has produced events recently
//   stalled  running but no Session event for longer than stallMs (NOT failed)
//   done     reply captured
//   failed   admission/wait failed, or the turn ended with an error reason
//   orphaned a persisted record whose owning process is gone (after restart)
//
// v0.1 note retained: per-Session serialization keeps replies from crossing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_MAX_RECORDS = 500;
const DEFAULT_STALL_MS = 120000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function preview(text, max = 200) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max);
}

/** Default durable location: <DSH_HOME>/dsh-session-inject/submissions.jsonl. */
export function defaultPersistencePath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'dsh-session-inject', 'submissions.jsonl');
}

export function createSubmissionStore(options = {}) {
  const records = new Map();
  const chains = new Map();
  const maxRecords = options.maxRecords || DEFAULT_MAX_RECORDS;
  const maxTurnMs = options.maxTurnMs || 10 * 60 * 1000;
  const stallMs = options.stallMs || DEFAULT_STALL_MS;
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
  const persistPath = options.persistPath === null
    ? null
    : options.persistPath || defaultPersistencePath();
  const persisted = new Map();

  // ---------------------------------------------------------------- persistence
  function ensureDir() {
    if (!persistPath) return false;
    try {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  function snapshotLine(record) {
    return {
      submission_id: record.submission_id,
      session_id: record.session_id,
      status: record.status,
      delivery: record.delivery,
      created_at: record.created_at,
      started_at: record.started_at,
      ended_at: record.ended_at,
      updated_at: Date.now(),
      last_activity_at: record.last_activity_at,
      last_event_type: record.last_event_type,
      steps_seen: record.steps_seen,
      reply_preview: preview(record.reply_text),
      reply_chars: typeof record.reply_text === 'string' ? record.reply_text.length : 0,
      error: record.error || null,
      wait_capped: record.wait_capped === true,
      requested_ms: record.requested_ms || 0,
      effective_ms: record.effective_ms || 0,
      turn_end_seq: record.turn_end_seq ?? null,
    };
  }

  function persist(record) {
    if (!persistPath) return;
    if (!ensureDir()) return;
    try {
      record.updated_at = Date.now();
      fs.appendFileSync(persistPath, JSON.stringify(snapshotLine(record)) + '\n', 'utf8');
    } catch {
      /* persistence is best effort; the in-memory record still works */
    }
  }

  function loadPersisted() {
    if (!persistPath || !fs.existsSync(persistPath)) return;
    const latest = new Map();
    let text = '';
    try {
      text = fs.readFileSync(persistPath, 'utf8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (!row || typeof row.submission_id !== 'string') continue;
        if (typeof row.updated_at === 'number' && Date.now() - row.updated_at > ttlMs) continue;
        latest.set(row.submission_id, row);
      } catch {
        /* skip corrupt line */
      }
    }
    // Compact the file on startup: latest record per id, TTL applied.
    try {
      const compact = [...latest.values()].map((row) => JSON.stringify(row) + '\n').join('');
      fs.writeFileSync(persistPath, compact, 'utf8');
    } catch {
      /* ignore */
    }
    for (const row of latest.values()) {
      persisted.set(row.submission_id, { ...row, orphaned: true });
    }
  }

  loadPersisted();

  // ------------------------------------------------------------------- records
  function prune() {
    if (records.size <= maxRecords) return;
    const finished = [...records.values()]
      .filter((record) => record.status === 'done' || record.status === 'failed')
      .sort((a, b) => a.created_at - b.created_at);
    while (records.size > maxRecords && finished.length > 0) {
      const oldest = finished.shift();
      records.delete(oldest.submission_id);
    }
  }

  function create({ sessionId, content, delivery, requestedMs, effectiveMs, waitCapped }) {
    const now = Date.now();
    const record = {
      submission_id: 'sub-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 10),
      session_id: sessionId,
      content,
      delivery: delivery === 'steer' ? 'steer' : 'queue',
      status: 'queued',
      created_at: now,
      started_at: null,
      ended_at: null,
      last_activity_at: now,
      last_event_type: null,
      steps_seen: 0,
      after_seq: null,
      reply_text: null,
      error: null,
      failure: null,
      turn_end_reason: null,
      assistant_texts: null,
      scan_stats: null,
      turn_end_seq: null,
      wait_capped: waitCapped === true,
      requested_ms: requestedMs || 0,
      effective_ms: effectiveMs || 0,
      last_persist_at: 0,
    };
    records.set(record.submission_id, record);
    prune();
    persist(record);
    return record;
  }

  function get(submissionId) {
    return records.get(submissionId) || null;
  }

  function getPersisted(submissionId) {
    return persisted.get(submissionId) || null;
  }

  function touch(record, event) {
    if (!record || !event) return;
    if (event.type === 'step/start') record.steps_seen += 1;
    record.last_event_type = event.type;
    const eventTime = Number.isFinite(event.time) ? event.time : Date.now();
    if (!Number.isFinite(record.last_activity_at) || eventTime > record.last_activity_at) {
      record.last_activity_at = eventTime;
    }
  }

  function markRunning(record) {
    record.status = 'running';
    record.started_at = record.started_at || Date.now();
    record.last_activity_at = Date.now();
    persist(record);
  }

  function markDone(record) {
    record.status = 'done';
    record.ended_at = Date.now();
    persist(record);
  }

  function markFailed(record, message, extra = {}) {
    record.status = 'failed';
    record.ended_at = Date.now();
    record.error = message || record.error || 'failed';
    if (extra.failure) record.failure = extra.failure;
    persist(record);
  }

  function maybePersist(record, minIntervalMs = 5000) {
    if (!record) return;
    if (Date.now() - (record.last_persist_at || 0) < minIntervalMs) return;
    record.last_persist_at = Date.now();
    persist(record);
  }

  // -------------------------------------------------------------------- phases
  function phaseOf(record, now = Date.now()) {
    if (record.orphaned) return 'orphaned';
    if (record.status === 'done') return 'done';
    if (record.status === 'failed') return 'failed';
    if (record.status === 'queued') return 'queued';
    const last = Number.isFinite(record.last_activity_at) ? record.last_activity_at : record.started_at || record.created_at;
    return now - last > stallMs ? 'stalled' : 'running';
  }

  function queuePositionOf(record) {
    if (!record || record.status !== 'queued' || record.orphaned) return null;
    const peers = [...records.values()]
      .filter((row) => row.session_id === record.session_id && row.status === 'queued' && row.created_at <= record.created_at)
      .sort((a, b) => a.created_at - b.created_at);
    const index = peers.findIndex((row) => row.submission_id === record.submission_id);
    return index >= 0 ? index + 1 : null;
  }

  /** One API-shaped summary (live or persisted/orphaned). */
  function summarize(record, now = Date.now()) {
    const live = !record.orphaned;
    const startedAt = record.started_at || null;
    const endedAt = record.ended_at || null;
    const lastActivity = Number.isFinite(record.last_activity_at) ? record.last_activity_at : (startedAt || record.created_at);
    return {
      submission_id: record.submission_id,
      session_id: record.session_id,
      status: record.status,
      phase: phaseOf(record, now),
      delivery: record.delivery,
      created_at: iso(record.created_at),
      started_at: iso(startedAt),
      elapsed_ms: startedAt ? Math.max(0, (endedAt || now) - startedAt) : 0,
      steps_seen: record.steps_seen || 0,
      last_event_type: record.last_event_type || null,
      last_activity_at: iso(lastActivity),
      idle_ms: Math.max(0, now - lastActivity),
      reply_preview: record.reply_preview !== undefined && record.orphaned
        ? record.reply_preview
        : preview(record.reply_text),
      wait_capped: record.wait_capped === true,
      ...(live ? {} : { orphaned: true }),
      ...(record.error ? { error: record.error } : {}),
    };
  }

  function list({ sessionId, limit = 10, status } = {}) {
    const now = Date.now();
    const rows = [];
    for (const record of records.values()) {
      if (sessionId && record.session_id !== sessionId) continue;
      rows.push(summarize(record, now));
    }
    for (const record of persisted.values()) {
      if (records.has(record.submission_id)) continue;
      if (sessionId && record.session_id !== sessionId) continue;
      const summary = summarize(record, now);
      if (status && summary.status !== status && summary.phase !== status) continue;
      rows.push(summary);
    }
    const filtered = rows.filter((row) => {
      if (!status) return true;
      if (row.status === status || row.phase === status) return true;
      return status === 'orphaned' && row.orphaned === true;
    });
    filtered.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    return filtered.slice(0, Math.max(1, Math.min(100, limit)));
  }

  // ------------------------------------------------------------------- running
  function run(record, job) {
    const previous = chains.get(record.session_id) || Promise.resolve();
    const current = previous.then(async () => {
      if (record.status === 'cancelled') return;
      markRunning(record);
      try {
        await job(record);
      } catch (error) {
        markFailed(record, error && error.message ? error.message : String(error));
      } finally {
        record.ended_at = record.ended_at || Date.now();
      }
    }).catch((error) => {
      markFailed(record, error && error.message ? error.message : String(error));
    });
    chains.set(record.session_id, current);
    current.finally(() => {
      if (chains.get(record.session_id) === current) chains.delete(record.session_id);
    });
    return current;
  }

  function runImmediately(record, job) {
    markRunning(record);
    return (async () => {
      try {
        await job(record);
      } catch (error) {
        markFailed(record, error && error.message ? error.message : String(error));
      } finally {
        record.ended_at = record.ended_at || Date.now();
      }
    })();
  }

  return {
    create,
    get,
    getPersisted,
    touch,
    markRunning,
    markDone,
    markFailed,
    maybePersist,
    persist,
    summarize,
    phaseOf,
    queuePositionOf,
    list,
    run,
    runImmediately,
    records,
    persisted,
    maxTurnMs,
    stallMs,
    persistPath,
  };
}
