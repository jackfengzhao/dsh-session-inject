#!/usr/bin/env node
// Minimal asar reader (no @electron/asar dependency).
// Usage:
//   node asar.mjs list <archive> [regexFilter]
//   node asar.mjs cat <archive> <innerPath>
//   node asar.mjs extract <archive> <innerDir> <outDir>
import fs from 'node:fs';
import path from 'node:path';

const ARCHIVE = process.env.ASAR || 'C:\\Users\\<user>\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar';

function openArchive(archive = ARCHIVE) {
  const buf = fs.readFileSync(archive);
  const magic = buf.readUInt32LE(0);
  if (magic !== 4) throw new Error('not an asar (magic=' + magic + ')');
  const headerSize = buf.readUInt32LE(4);
  const headerStrSize = buf.readUInt32LE(12);
  const jsonStart = 16;
  const json = buf.slice(jsonStart, jsonStart + headerStrSize).toString('utf8');
  const header = JSON.parse(json);
  // Data section begins right after the JSON header.
  const dataStart = jsonStart + headerStrSize;
  return { buf, header, dataStart, headerSize };
}

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files)) {
    const p = prefix ? prefix + '/' + name : name;
    if (entry.files) walk(entry, p, out);
    else out.push({ path: p, size: entry.size, offset: entry.offset, unpacked: !!entry.unpacked, executable: !!entry.executable, link: entry.link });
  }
}

function list(archive, filter) {
  const { header } = openArchive(archive);
  const out = [];
  walk(header, '', out);
  const re = filter ? new RegExp(filter, 'i') : null;
  return out.filter((f) => !re || re.test(f.path));
}

function cat(archive, innerPath) {
  const { buf, header, dataStart } = openArchive(archive);
  let node = header;
  for (const part of innerPath.split('/').filter(Boolean)) {
    node = node.files?.[part];
    if (!node) throw new Error('not found: ' + innerPath);
  }
  if (node.files) throw new Error('is a directory: ' + innerPath);
  if (node.unpacked) throw new Error('unpacked, read from app.asar.unpacked: ' + innerPath);
  return buf.slice(dataStart + Number(node.offset), dataStart + Number(node.offset) + node.size);
}

function extract(archive, innerDir, outDir) {
  const { buf, header, dataStart } = openArchive(archive);
  let node = header;
  for (const part of innerDir.split('/').filter(Boolean)) {
    node = node.files?.[part];
    if (!node) throw new Error('not found: ' + innerDir);
  }
  const entries = [];
  if (node.files) walk(node, innerDir, entries);
  else entries.push({ path: innerDir, size: node.size, offset: node.offset, unpacked: !!node.unpacked });
  let n = 0;
  for (const e of entries) {
    if (e.unpacked) continue;
    const dst = path.join(outDir, e.path);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buf.slice(dataStart + Number(e.offset), dataStart + Number(e.offset) + e.size));
    n++;
  }
  return { files: n, dirs: entries.length };
}

function grep(archive, pattern, pathFilter) {
  const { buf, header, dataStart } = openArchive(archive);
  const entries = [];
  walk(header, '', entries);
  const re = new RegExp(pattern);
  const pre = pathFilter ? new RegExp(pathFilter, 'i') : null;
  const hits = [];
  for (const e of entries) {
    if (e.unpacked || e.link) continue;
    if (pre && !pre.test(e.path)) continue;
    const text = buf.slice(dataStart + Number(e.offset), dataStart + Number(e.offset) + e.size).toString('utf8');
    let m;
    const r = new RegExp(pattern, 'g');
    let count = 0;
    while ((m = r.exec(text)) !== null && count < 5) {
      const s = Math.max(0, m.index - 160);
      const ctx = text.slice(s, m.index + 200);
      hits.push({ path: e.path, index: m.index, context: ctx });
      count++;
    }
  }
  return hits;
}

const [cmd, archive, a, b] = process.argv.slice(2);
if (cmd === 'list') {
  const rows = list(archive);
  console.log(JSON.stringify({ count: rows.length, sample: rows.slice(0, 40) }, null, 2));
} else if (cmd === 'cat') {
  process.stdout.write(cat(archive, a));
} else if (cmd === 'extract') {
  console.log(JSON.stringify(extract(archive, a, b)));
} else if (cmd === 'catout') {
  fs.writeFileSync(b, cat(archive, a));
  console.log(JSON.stringify({ written: b, bytes: fs.statSync(b).size }));
} else if (cmd === 'grep') {
  console.log(JSON.stringify(grep(archive, a, b), null, 2));
} else {
  console.log('usage: node asar.mjs list|cat|extract ...');
  process.exit(1);
}
