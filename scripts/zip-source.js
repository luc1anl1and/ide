#!/usr/bin/env node
'use strict';
// Creates release/reva-source-<version>.zip containing the repository sources (no node_modules, build output,
// VCS data, logs or local settings) under a top-level folder reva-<version>/.
// Pure Node, no dependencies: a tiny ZIP writer (deflate, UTF-8 names, forward slashes).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const top = `hyper-ide-${pkg.version}`;
const outDir = path.join(root, 'release');
const outFile = path.join(outDir, `hyper-ide-source-${pkg.version}.zip`);

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'release', 'out', '.git', '.svn', '.hg', '.claude', '.vscode', '.idea', 'coverage', 'tmp', 'temp', '.cache']);
const EXCLUDE_FILE = [/\.log$/i, /\.tmp$/i, /~$/, /^\.env(\..*)?$/i, /^npm-debug\.log/, /^Thumbs\.db$/i, /^\.DS_Store$/, /\.zip$/i, /\.exe$/i, /^settings\.json$/i, /^keys\.json$/i];

function walk(dir, rel, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = rel ? rel + '/' + ent.name : ent.name;
    if (ent.isDirectory()) { if (!EXCLUDE_DIRS.has(ent.name)) walk(path.join(dir, ent.name), r, out); }
    else if (ent.isFile() && !EXCLUDE_FILE.some((re) => re.test(ent.name))) out.push(r);
  }
  return out;
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function dos(d) {
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

const files = walk(root, '', []);
const chunks = []; const central = []; let offset = 0;
for (const rel of files) {
  const data = fs.readFileSync(path.join(root, rel));
  const name = Buffer.from(`${top}/${rel}`, 'utf8');
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const useDeflate = comp.length < data.length;
  const body = useDeflate ? comp : data;
  const method = useDeflate ? 8 : 0;
  const crc = crc32(data);
  const { time, date } = dos(fs.statSync(path.join(root, rel)).mtime);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
  lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
  chunks.push(lh, name, body);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
  ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(0o100644 << 16 >>> 0, 38); ch.writeUInt32LE(offset, 42);
  central.push(ch, name);
  offset += lh.length + name.length + body.length;
}
const cdSize = central.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, Buffer.concat([...chunks, ...central, end]));
console.log(`${files.length} files -> ${path.relative(root, outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB)`);
