#!/usr/bin/env node
// Decompress one DSH session log (session.v4.jsonl.zstd) and print a summary.
// Usage:
//   node tools/session-tail.mjs <path-to-session.v4.jsonl.zstd> [--events] [--all] [--turn N] [--out file]
//   --all    also print non-user user/message events (runtime context, skills)
//   --out    write the report as UTF-8 to a file (avoids Windows console code pages)
import fs from 'node:fs';
import zlib from 'node:zlib';

const file = process.argv[2];
const showEvents = process.argv.includes('--events');
const showAll = process.argv.includes('--all');
const turnArg = process.argv.indexOf('--turn');
const wantTurn = turnArg >= 0 ? Number(process.argv[turnArg + 1]) : null;
const outArg = process.argv.indexOf('--out');
const outPath = outArg >= 0 ? process.argv[outArg + 1] : null;
if (!file) {
  console.error('usage: node tools/session-tail.mjs <session.v4.jsonl.zstd> [--events] [--all] [--turn N] [--out file]');
  process.exit(1);
}

const raw = fs.readFileSync(file);
let text = null;
try {
  // The log is an append-only sequence of independent zstd frames, one per
  // persisted batch. Decode every frame; also handles a single-frame file.
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const starts = [];
  for (let i = 0; i < raw.length - 3; i++) {
    if (raw[i] === magic[0] && raw[i + 1] === magic[1] && raw[i + 2] === magic[2] && raw[i + 3] === magic[3]) {
      starts.push(i);
    }
  }
  const parts = [];
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : raw.length;
    try { parts.push(zlib.zstdDecompressSync(raw.subarray(starts[k], end))); } catch { /* false-positive magic or skippable frame */ }
  }
  if (parts.length > 0) text = Buffer.concat(parts).toString('utf8');
  else text = zlib.zstdDecompressSync(raw).toString('utf8');
} catch (error) {
  console.error('could not decompress: ' + error.message);
  process.exit(1);
}

const lines = text.split('\n').filter((line) => line.trim().length > 0);
const events = [];
for (const line of lines) {
  try { events.push(JSON.parse(line)); } catch { /* partial line */ }
}

const counts = {};
for (const event of events) counts[event.type] = (counts[event.type] || 0) + 1;
const turns = events.filter((e) => e.type === 'turn/start').map((e) => ({ turn: e.data && e.data.turn, start: e.seq, end: null }));
const ends = events.filter((e) => e.type === 'turn/end');
for (const end of ends) {
  const turn = end.data && end.data.turn;
  const row = turns.find((t) => t.turn === turn && t.end === null);
  if (row) row.end = end.seq;
}

const out = [];
out.push(JSON.stringify({
  file,
  bytes: raw.length,
  events: events.length,
  counts,
  turns,
  firstSeq: events.length ? events[0].seq : null,
  lastSeq: events.length ? events[events.length - 1].seq : null,
}, null, 2));

for (const event of events) {
  const turn = event.data && event.data.turn;
  if (wantTurn !== null && turn !== wantTurn) continue;
  if (event.type === 'user/message') {
    const source = event.data?.source;
    if (!showAll && source?.kind !== 'user') continue;
    const content = Array.isArray(event.data?.content)
      ? event.data.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('')
      : '';
    out.push('\n[user/message] seq=' + event.seq + ' source=' + JSON.stringify(source));
    out.push('  text: ' + JSON.stringify(content));
  } else if (event.type === 'assistant/message') {
    const content = Array.isArray(event.data?.message?.content)
      ? event.data.message.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('')
      : '';
    out.push('\n[assistant/message] seq=' + event.seq + ' turn=' + turn);
    out.push('  text: ' + JSON.stringify(content));
  } else if (event.type === 'turn/start' || event.type === 'turn/end') {
    out.push('\n[' + event.type + '] seq=' + event.seq + ' data=' + JSON.stringify(event.data));
  } else if (showEvents) {
    out.push('[' + event.type + '] seq=' + event.seq + ' data=' + JSON.stringify(event.data).slice(0, 400));
  }
}

const rendered = out.join('\n') + '\n';
if (outPath) fs.writeFileSync(outPath, rendered, 'utf8');
process.stdout.write(rendered);
