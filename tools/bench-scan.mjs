#!/usr/bin/env node
// Micro-benchmark: v0.1 full-snapshot scan vs v0.2 incremental tail scan.
//
// Models the host's `session.snapshotEvents(from?)`: no argument returns a copy
// of the whole log; an offset returns a copy of the tail. The v0.1 wait loop
// called snapshotEvents() every poll and filtered for seq >= cursor; v0.2 calls
// snapshotEvents(cursor).
//
// Usage: node tools/bench-scan.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(here, '..', 'docs', 'evidence', '2x-perf-synthetic.json');

function makeLog(n) {
  const events = new Array(n);
  for (let i = 0; i < n; i++) events[i] = { type: i % 7 === 0 ? 'assistant/message' : 'tool/result', seq: i, data: {} };
  return events;
}

function run(n, iterations) {
  const all = makeLog(n);
  const cursor = n - 5; // five new events to observe
  const session = {
    snapshotEvents(from) {
      return from === undefined ? all.slice() : all.slice(from);
    },
  };

  // warmup
  for (let i = 0; i < Math.min(iterations, 3); i++) {
    session.snapshotEvents().filter((event) => event.seq >= cursor);
    session.snapshotEvents(cursor);
  }

  const legacyStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    const fresh = session.snapshotEvents().filter((event) => event.seq >= cursor);
    for (const event of fresh) { /* scan */ }
  }
  const legacyMs = performance.now() - legacyStart;

  const incStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    const fresh = session.snapshotEvents(cursor);
    for (const event of fresh) { /* scan */ }
  }
  const incMs = performance.now() - incStart;

  return {
    events: n,
    iterations,
    legacy_full_scan: {
      total_ms: Math.round(legacyMs * 1000) / 1000,
      per_scan_ms: Math.round((legacyMs / iterations) * 10000) / 10000,
    },
    incremental_tail_scan: {
      total_ms: Math.round(incMs * 1000) / 1000,
      per_scan_ms: Math.round((incMs / iterations) * 10000) / 10000,
    },
    speedup: incMs > 0 ? Math.round((legacyMs / incMs) * 100) / 100 : null,
  };
}

const results = [run(10000, 200), run(100000, 50), run(1000000, 10)];
const evidence = {
  captured_at: new Date().toISOString(),
  note: 'Synthetic micro-benchmark of snapshotEvents() + filter (v0.1) vs snapshotEvents(cursor) (v0.2). Real 20-turn measurement: docs/evidence/2x-perf-legacy.json and 2x-perf-incremental.json.',
  results,
};
fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(evidence, null, 2));
