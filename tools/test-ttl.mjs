#!/usr/bin/env node
// R5 unit check: startup compaction keeps the latest record per id and drops
// records older than the TTL (default 24h), without touching the live store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSubmissionStore } from '../lib/records.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-si-ttl-'));
const file = path.join(dir, 'submissions.jsonl');
const now = Date.now();
const rows = [
  { submission_id: 'old-1', session_id: 's1', status: 'running', created_at: now - 26 * 3600e3, updated_at: now - 25 * 3600e3, last_activity_at: now - 25 * 3600e3 },
  { submission_id: 'fresh-1', session_id: 's2', status: 'running', created_at: now - 60e3, updated_at: now - 30e3, last_activity_at: now - 30e3 },
  { submission_id: 'fresh-1', session_id: 's2', status: 'done', created_at: now - 60e3, updated_at: now - 10e3, last_activity_at: now - 10e3, reply_preview: 'TTL-OK' },
];
fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

const store = createSubmissionStore({ persistPath: file, stallMs: 120000 });
const remaining = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

const evidence = {
  captured_at: new Date().toISOString(),
  file,
  input_lines: rows.length,
  persisted_after_load: [...store.persisted.keys()],
  remaining_lines: remaining.length,
  remaining_rows: remaining.map((line) => JSON.parse(line)),
  checks: {
    old_dropped: !store.persisted.has('old-1'),
    fresh_kept: store.persisted.has('fresh-1'),
    latest_wins: store.persisted.get('fresh-1')?.status === 'done',
    file_compacted: remaining.length === 1,
    orphaned_flag: store.persisted.get('fresh-1')?.orphaned === true,
  },
};
fs.writeFileSync(path.join(process.cwd(), 'docs', 'evidence', '3x-ttl.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ checks: evidence.checks, persisted: evidence.persisted_after_load, remaining_lines: remaining.length }, null, 2));
process.exit(Object.values(evidence.checks).every(Boolean) ? 0 : 1);
