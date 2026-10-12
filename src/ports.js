// Main-process module: finds local dev servers (listening TCP ports that answer HTTP).
//
//   require('./ports').register({ ipcMain })
//
// IPC channels:
//   ports:scan                       -> [{ port, host, pid, process, title, url, ok, status }]
//   ports:dockDevTools(targetId, hostId) -> boolean   (docks devtools of one <webview> inside another)
//
// Never throws: every failure degrades to an empty list / false.
const http = require('http');
const { execFile } = require('child_process');

const PROBE_TIMEOUT = 800;      // ms per HTTP probe
const MAX_CANDIDATES = 120;     // hard cap so a machine with many listeners still scans fast
const CACHE_MS = 700;           // coalesce bursts (start page + dropdown asking at once)

// Ports we never probe: Windows/system services that listen on high-ish ports.
const SKIP_PORTS = new Set([1433, 1434, 3306, 3389, 5040, 5357, 5432, 5985, 5986, 6379, 7680, 27017]);
// Processes that never serve a dev site.
const SKIP_PROCS = new Set(['system', 'svchost', 'lsass', 'services', 'wininit', 'spoolsv', 'rpcss', 'dns', 'sqlservr', 'postgres', 'mysqld', 'redis-server', 'mongod', 'docker', 'com.docker.backend']);

// Dev ports to list first.
const DEV_PORTS = new Set([
  ...range(3000, 3010), 4200, 4321, 5000, ...range(5173, 5180), ...range(8000, 8100), 8080, 8888, 9000,
]);
function range(a, b) { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; }

const run = (cmd, args, timeout = 4000) => new Promise((resolve) => {
  try {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
  } catch { resolve(''); }
});

// ---- listening sockets ----
// Parses `netstat -ano -p tcp`. Returns Map(port -> { port, hosts:Set, pid }).
async function listening() {
  const out = await run('netstat', ['-ano', '-p', 'tcp']);
  const m = new Map();
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t.length < 5 || t[0] !== 'TCP' || !/^LISTENING$/i.test(t[3])) continue;
    const i = t[1].lastIndexOf(':');
    if (i < 0) continue;
    const addr = t[1].slice(0, i).replace(/^\[|\]$/g, '');
    const port = +t[1].slice(i + 1);
    const pid = +t[4];
    // loopback or wildcard only
    if (!['0.0.0.0', '::', '127.0.0.1', '::1'].includes(addr)) continue;
    if (!(port >= 1024 && port <= 65535) || SKIP_PORTS.has(port)) continue;
    const e = m.get(port) || { port, hosts: new Set(), pid };
    e.hosts.add(addr);
    m.set(port, e);
  }
  return m;
}

// pid -> process name (lowercase, without .exe)
async function processNames() {
  const out = await run('tasklist', ['/FO', 'CSV', '/NH'], 5000);
  const map = new Map();
  for (const line of out.split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line);
    if (m) map.set(+m[2], m[1].replace(/\.exe$/i, ''));
  }
  return map;
}

// ---- HTTP probe ----
function probeHost(host, port) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = http.get({ host, port, path: '/', timeout: PROBE_TIMEOUT, headers: { Accept: 'text/html,*/*;q=0.5', 'User-Agent': 'RevaPortScan/1' }, agent: false }, (res) => {
        const ct = String(res.headers['content-type'] || '');
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          if (buf.length < 32768) buf += c;
          if (buf.length >= 32768 || /<\/title>/i.test(buf)) { res.destroy(); }
        });
        const end = () => {
          let title = '';
          if (/html/i.test(ct) || /<title/i.test(buf)) {
            const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(buf);
            if (t) title = t[1].replace(/\s+/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim().slice(0, 120);
          }
          fin({ status: res.statusCode, title, ct });
        };
        res.on('end', end); res.on('close', end); res.on('error', end);
      });
      req.on('timeout', () => { req.destroy(); fin(null); });
      req.on('error', () => fin(null));
      setTimeout(() => { try { req.destroy(); } catch {} fin(null); }, PROBE_TIMEOUT + 150);
    } catch { fin(null); }
  });
}

async function probe(port, hosts) {
  // try IPv4 first, then IPv6 loopback when the server only bound ::1/::
  const order = [];
  if (hosts.has('127.0.0.1') || hosts.has('0.0.0.0')) order.push('127.0.0.1');
  if (hosts.has('::1') || hosts.has('::')) order.push('::1');
  if (!order.length) order.push('127.0.0.1');
  const attempts = await Promise.all(order.map((h) => probeHost(h, port).then((r) => r && { host: h, ...r })));
  return attempts.find(Boolean) || null;
}

let cache = { t: 0, p: null };
async function scanUncached() {
  const [socks, names] = await Promise.all([listening(), processNames()]);
  let cands = [...socks.values()];
  if (!cands.length) {
    // netstat unavailable: fall back to blind probing of the usual dev ports
    cands = [...DEV_PORTS].map((port) => ({ port, hosts: new Set(['127.0.0.1', '::1']), pid: 0 }));
  }
  cands = cands.filter((c) => !SKIP_PROCS.has((names.get(c.pid) || '').toLowerCase()));
  cands.sort((a, b) => (DEV_PORTS.has(b.port) - DEV_PORTS.has(a.port)) || a.port - b.port);
  cands = cands.slice(0, MAX_CANDIDATES);

  const res = await Promise.all(cands.map(async (c) => {
    const r = await probe(c.port, c.hosts);
    if (!r) return null;
    // error-only listeners (Discord, Steam, launchers...) are noise unless on a typical dev port
    if (r.status >= 400 && (!r.title || /not found|forbidden|error|^4\d\d/i.test(r.title)) && !DEV_PORTS.has(c.port)) return null;
    return {
      port: c.port, host: 'localhost', pid: c.pid, process: names.get(c.pid) || '',
      title: r.title, url: `http://localhost:${c.port}/`, ok: true, status: r.status,
    };
  }));
  return res.filter(Boolean).sort((a, b) => (DEV_PORTS.has(b.port) - DEV_PORTS.has(a.port)) || a.port - b.port);
}

function scan() {
  const now = Date.now();
  if (cache.p && now - cache.t < CACHE_MS) return cache.p;
  const budget = new Promise((r) => setTimeout(() => r(null), 2400));
  const p = Promise.race([scanUncached(), budget]).then((v) => v || []).catch(() => []);
  cache = { t: now, p };
  return p;
}

function register({ ipcMain }) {
  ipcMain.handle('ports:scan', async () => { try { return await scan(); } catch { return []; } });

  // Docks the devtools of webview `targetId` into webview `hostId` (both are guest webContents ids,
  // from <webview>.getWebContentsId()). The host webview must be a fresh about:blank guest.
  ipcMain.handle('ports:dockDevTools', async (_e, targetId, hostId) => {
    try {
      const { webContents } = require('electron');
      const target = webContents.fromId(targetId), host = webContents.fromId(hostId);
      if (!target || !host || target.isDestroyed() || host.isDestroyed()) return false;
      target.setDevToolsWebContents(host);
      target.openDevTools();
      return true;
    } catch { return false; }
  });
  ipcMain.handle('ports:closeDevTools', async (_e, targetId) => {
    try {
      const { webContents } = require('electron');
      const t = webContents.fromId(targetId);
      if (t && !t.isDestroyed()) t.closeDevTools();
      return true;
    } catch { return false; }
  });
  // Screenshot of a guest webContents -> { data: base64 png, width, height }.
  ipcMain.handle('ports:capture', async (_e, id) => {
    try {
      const { webContents } = require('electron');
      const wc = webContents.fromId(id);
      if (!wc || wc.isDestroyed()) return null;
      const img = await wc.capturePage();
      const size = img.getSize();
      return { data: img.toPNG().toString('base64'), width: size.width, height: size.height };
    } catch { return null; }
  });

  // Lets the preview session accept a self-signed certificate for one local host ("Continue anyway").
  ipcMain.handle('ports:trust', async (_e, host) => {
    try {
      host = String(host || '');
      if (!isLocalHost(host)) return false;
      trustedHosts.add(host);
      installCertProc();
      return true;
    } catch { return false; }
  });

  installGuestHooks();
}

// ---- preview-session hooks (certificate trust, popups, shortcut forwarding) ----
const PARTITION = 'persist:preview';
const trustedHosts = new Set();
let certInstalled = false, hooksInstalled = false;

function isLocalHost(h) { return /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0|[\w-]+\.localhost)$/i.test(h); }

function installCertProc() {
  if (certInstalled) return;
  try {
    const { session } = require('electron');
    session.fromPartition(PARTITION).setCertificateVerifyProc((req, cb) => cb(trustedHosts.has(req.hostname) ? 0 : -3));
    certInstalled = true;
  } catch {}
}

// Shortcuts that must keep working while the guest page has keyboard focus.
function keyCmd(i) {
  if (i.type !== 'keyDown') return null;
  const k = i.key, c = i.control || i.meta;
  if (i.alt && !c) { if (k === 'ArrowLeft') return 'back'; if (k === 'ArrowRight') return 'forward'; }
  if (k === 'F12') return 'devtools';
  if (k === 'F5') return i.shift || c ? 'hardReload' : 'reload';
  if (c && !i.alt) {
    const l = k.toLowerCase();
    if (l === 'l') return 'focusUrl';
    if (l === 'r') return i.shift ? 'hardReload' : 'reload';
    if (k === '=' || k === '+') return 'zoomIn';
    if (k === '-' || k === '_') return 'zoomOut';
    if (k === '0') return 'zoomReset';
  }
  return null;
}

function installGuestHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  try {
    const { app, session, shell } = require('electron');
    installCertProc();
    app.on('web-contents-created', (_e, wc) => {
      try {
        if (wc.getType() !== 'webview' || wc.session !== session.fromPartition(PARTITION)) return;
        // target=_blank / window.open: local pages open in the same webview, everything else in the system browser.
        wc.setWindowOpenHandler(({ url }) => {
          try {
            const u = new URL(url);
            if (/^https?:$/.test(u.protocol)) {
              if (isLocalHost(u.hostname)) wc.loadURL(url); else shell.openExternal(url);
            }
          } catch {}
          return { action: 'deny' };
        });
        wc.on('before-input-event', (e, input) => {
          const cmd = keyCmd(input);
          if (!cmd) return;
          e.preventDefault();
          const host = wc.hostWebContents;
          if (host && !host.isDestroyed()) host.send('ports:key', { id: wc.id, cmd });
        });
      } catch {}
    });
  } catch {}
}

module.exports = { register, scan };


