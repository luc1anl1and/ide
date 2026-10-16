// IDE tools server: an MCP (Model Context Protocol) server, "hyper-ide", that lets the coding agents running
// inside hyper-ide use the IDE's own features (preview browser, editor, terminal).
//
//   start({ invoke, token, getExtraTools? }) -> Promise<{ url, port, token, close() }>
//       invoke(toolName, args) -> Promise<{ content:[{type:'text',text}|{type:'image',data,mimeType}], isError? }>
//       (implemented by the app, typically over IPC to the renderer). 25 s timeout per call.
//       getExtraTools() -> [{ name, title?, description, inputSchema, readOnly? }]: extra tools (contributed by plugins) merged
//       into tools/list on every request; calls to them go through the same invoke(name, args).
//   agentConfig(provider, info, opts) -> { args?, env?, configArgs?, extraArgs?, inlineConfig?, allowedTools?, hint }
//       info = { url, token }, opts = { enabled?, readOnlyAutoAllow? }. What main.js must inject per agent.
//   mergeInlineConfig(existing, fragment) -> JSON string for OPENCODE_CONFIG_CONTENT
//   TOOLS -> tool schemas (MCP shape)
//
// Transport: MCP "Streamable HTTP", POST /mcp, plain application/json replies (no SSE needed).
// Security: loopback only, Bearer token (constant-time compare), no CORS headers, requests carrying an
// Origin header (= browsers) or a foreign Host header (DNS rebinding) are rejected.
'use strict';
const http = require('http');
const crypto = require('crypto');
const pcMod = require('./pc');

const SERVER_NAME = 'hyper-ide';
const SERVER_VERSION = '1.0.0';
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const CALL_TIMEOUT_MS = 25000;
const LONG_TIMEOUT_MS = 150000; // pc_* tools wait for the user to answer a permission dialog
const MAX_BODY = 1 << 20;

// ------------------------------------------------------------------ tool schemas
const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const act = (idem = false) => ({ readOnlyHint: false, destructiveHint: false, idempotentHint: idem, openWorldHint: false });
const obj = (properties, required) => ({ type: 'object', properties, ...(required ? { required } : {}), additionalProperties: false });
const ID = { type: 'string', description: 'Preview tab id as returned by open_preview / ide_context. Omit to use the active preview tab.' };

const TOOLS = [
  {
    name: 'ide_context',
    title: 'IDE context',
    description: 'Shows what the user is looking at in the hyper-ide IDE right now: workspace folder, the active file (path, language, cursor line, currently selected text), all open editor tabs, open preview (browser) tabs with their id/url/title, and the number of terminals. Call it when the user refers to "this file", "the selection", "what I have open" or "the preview", or before using the preview_* tools to learn the preview ids.',
    inputSchema: obj({}),
    annotations: ro,
  },
  {
    name: 'open_file',
    title: 'Open file in editor',
    description: 'Opens a file in the IDE editor so the user can see it, optionally scrolled to a line. Use it to show the user the file you just created or the place you are talking about. Does not return the file contents (read the file with your normal file tools).',
    inputSchema: obj({
      path: { type: 'string', description: 'Absolute path, or path relative to the workspace folder.' },
      line: { type: 'integer', minimum: 1, description: 'Optional 1-based line to reveal and place the cursor on.' },
    }, ['path']),
    annotations: act(true),
  },
  {
    name: 'open_preview',
    title: 'Open site preview',
    description: 'Opens (or navigates) the IDE\'s built-in browser preview so the user - and you, via preview_screenshot / preview_console - can see the result. Use it right after you start a dev server (e.g. http://localhost:5173) or create/edit an HTML page, instead of asking the user to open a browser. Give either `url` or `file` (an HTML file in the workspace). Returns {id, url, title}; pass that id to the other preview_* tools.',
    inputSchema: obj({
      url: { type: 'string', description: 'Address to open, e.g. http://localhost:5173 .' },
      file: { type: 'string', description: 'Path of an HTML file in the workspace (absolute or workspace-relative) to open instead of a url.' },
      device: { type: 'string', description: 'Optional device preset for responsive checks, e.g. "iPhone 14", "iPad", "desktop".' },
      reuse: { type: 'boolean', description: 'Default true: navigate the existing preview tab instead of opening another one.' },
    }),
    annotations: act(true),
  },
  {
    name: 'preview_reload',
    title: 'Reload preview',
    description: 'Reloads a preview tab. Use after changing files when the dev server has no hot reload, or to get a clean state. `hard` bypasses the cache.',
    inputSchema: obj({ id: ID, hard: { type: 'boolean', description: 'Bypass the cache (default false).' } }),
    annotations: act(true),
  },
  {
    name: 'preview_screenshot',
    title: 'Screenshot preview',
    description: 'Takes a PNG screenshot of a preview tab and returns it as an image so you can SEE the page. Call it after making visual changes to check the result (layout, colors, broken images, empty page) before telling the user it is done. Combine with preview_console to catch errors that are not visible.',
    inputSchema: obj({
      id: ID,
      width: { type: 'integer', minimum: 100, maximum: 4000, description: 'Optional viewport width in CSS px for the capture.' },
      height: { type: 'integer', minimum: 100, maximum: 4000, description: 'Optional viewport height in CSS px for the capture.' },
    }),
    annotations: ro,
  },
  {
    name: 'preview_console',
    title: 'Read preview console',
    description: 'Returns recent console messages, uncaught runtime errors and failed resource loads from the preview page, one per line. Use it after loading or reloading a page to find out why something is blank or broken. By default returns only errors.',
    inputSchema: obj({
      id: ID,
      level: { type: 'string', enum: ['error', 'warn', 'all'], description: '"error" (default) = errors only, "warn" = warnings and errors, "all" = everything incl. log/info.' },
      clear: { type: 'boolean', description: 'Clear the buffer after reading (default false).' },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max lines, newest last (default 100).' },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'preview_html',
    title: 'Read preview DOM',
    description: 'Returns the DOM of the preview page as text: outerHTML of the first element matching `selector` (default body), or its visible text when `text` is true. Output is trimmed to max_chars. Use it to inspect the rendered structure or verify content when a screenshot is not enough.',
    inputSchema: obj({
      id: ID,
      selector: { type: 'string', description: 'CSS selector (default "body").' },
      text: { type: 'boolean', description: 'Return innerText instead of outerHTML (default false).' },
      max_chars: { type: 'integer', minimum: 100, maximum: 100000, description: 'Trim the result to this many characters (default 8000).' },
    }),
    annotations: ro,
  },
  {
    name: 'preview_eval',
    title: 'Run JavaScript in preview',
    description: 'Runs JavaScript inside the preview page and returns the JSON-serialised result of the last expression (promises are awaited). Use it to click buttons, fill forms, scroll, or read computed styles / app state when testing the page. It can change the page state and the user\'s app data, so prefer read-only snippets unless interaction is the point.',
    inputSchema: obj({
      id: ID,
      code: { type: 'string', description: 'JavaScript expression or statements; e.g. document.querySelector("button").click() or getComputedStyle(document.body).fontFamily' },
    }, ['code']),
    annotations: act(false),
  },
  {
    name: 'preview_snapshot',
    title: 'Read preview page (no screenshot)',
    description: 'Returns what the preview page shows as TEXT: url, title, scroll position, the visible headings/text and a numbered list of every interactive element (links, buttons, inputs, selects, tabs...) with its label, state and position. Each element gets a ref (e.g. 7) that preview_click / preview_type / preview_hover accept. Use this instead of screenshots to understand and test a page; refs are replaced by every snapshot, so take a new one after the page changes.',
    inputSchema: obj({ id: ID, max: { type: 'integer', minimum: 10, maximum: 500, description: 'Max interactive elements (default 120).' }, text_chars: { type: 'integer', minimum: 0, maximum: 20000, description: 'How much visible page text to include (default 2500).' } }),
    annotations: ro,
  },
  {
    name: 'preview_click',
    title: 'Click in preview',
    description: 'Clicks an element in the preview page with a real (trusted) mouse click: give `ref` from preview_snapshot, or a CSS `selector`, or visible `text` (best match), or raw viewport x,y. Scrolls the element into view first. Returns what changed (new url/title).',
    inputSchema: obj({ id: ID, ref: { type: 'integer', description: 'Ref from the latest preview_snapshot.' }, selector: { type: 'string' }, text: { type: 'string', description: 'Visible text of the element to click.' }, x: { type: 'number' }, y: { type: 'number' }, double: { type: 'boolean' }, right: { type: 'boolean', description: 'Right click.' } }),
    annotations: act(false),
  },
  {
    name: 'preview_hover',
    title: 'Hover in preview',
    description: 'Moves the mouse over an element (ref / selector / text / x,y) so hover menus and tooltips appear.',
    inputSchema: obj({ id: ID, ref: { type: 'integer' }, selector: { type: 'string' }, text: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }),
    annotations: act(true),
  },
  {
    name: 'preview_type',
    title: 'Type in preview',
    description: 'Types text into an input/textarea/contenteditable of the preview page (focus it with ref / selector / text first, or type into whatever has focus). Uses real input events so frameworks (React, Vue...) see the change. `clear` replaces existing content, `submit` presses Enter afterwards.',
    inputSchema: obj({ id: ID, text: { type: 'string' }, ref: { type: 'integer' }, selector: { type: 'string' }, clear: { type: 'boolean' }, submit: { type: 'boolean' } }, ['text']),
    annotations: act(false),
  },
  {
    name: 'preview_press',
    title: 'Press a key in preview',
    description: 'Presses a key or shortcut inside the preview page, e.g. "Enter", "Escape", "Tab", "ArrowDown", "Control+A", "Shift+Tab".',
    inputSchema: obj({ id: ID, key: { type: 'string' } }, ['key']),
    annotations: act(false),
  },
  {
    name: 'preview_scroll',
    title: 'Scroll preview',
    description: 'Scrolls the preview page (or the element given by ref/selector): direction up/down/top/bottom, amount in pixels (default one screen).',
    inputSchema: obj({ id: ID, direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] }, amount: { type: 'integer', minimum: 1, maximum: 20000 }, ref: { type: 'integer' }, selector: { type: 'string' } }, ['direction']),
    annotations: act(true),
  },
  {
    name: 'preview_wait',
    title: 'Wait in preview',
    description: 'Waits until the given text appears (or disappears with `gone: true`) in the preview page, or just for `ms` milliseconds. Use after clicking something that loads content.',
    inputSchema: obj({ id: ID, text: { type: 'string' }, gone: { type: 'boolean' }, ms: { type: 'integer', minimum: 0, maximum: 20000 }, timeout: { type: 'integer', minimum: 1, maximum: 20, description: 'Max seconds to wait for the text (default 8).' } }),
    annotations: ro,
  },  {
    name: 'terminal_run',
    title: 'Run command in IDE terminal',
    description: 'Types a command into the IDE\'s visible terminal (the user can watch it) and returns the output captured during wait_ms. Use for long-running processes you want the user to see, such as a dev server (`npm run dev`); for ordinary one-off commands prefer your own shell tool. Output of still-running commands can be fetched later with terminal_read.',
    inputSchema: obj({
      command: { type: 'string', description: 'The command line to run.' },
      new_tab: { type: 'boolean', description: 'Open a new terminal tab for it (recommended for servers). Default false.' },
      wait_ms: { type: 'integer', minimum: 0, maximum: 20000, description: 'How long to wait for output before returning (default 1500, max 20000).' },
    }, ['command']),
    annotations: act(false),
  },
  {
    name: 'terminal_read',
    title: 'Read IDE terminal',
    description: 'Returns the last N lines of output from the IDE\'s visible terminal. Use it to check on a dev server or build started with terminal_run, or to see what the user ran.',
    inputSchema: obj({
      lines: { type: 'integer', minimum: 1, maximum: 2000, description: 'Number of lines (default 200).' },
      tab: { type: 'integer', minimum: 0, description: 'Terminal tab index (default: the active terminal).' },
    }),
    annotations: ro,
  },
];
TOOLS.push(...pcMod.PC_TOOLS);
const TOOL_NAMES = TOOLS.map((t) => t.name);
// Tools the user does not need to confirm: they show things or read state, they cannot run code or commands.
// (pc_* tools are listed here because Reva asks the user itself, with its own native dialog, before any of them runs.)
const SAFE_TOOLS = ['ide_context', 'open_file', 'open_preview', 'preview_reload', 'preview_screenshot', 'preview_console', 'preview_html', 'preview_snapshot', 'preview_click', 'preview_hover', 'preview_type', 'preview_press', 'preview_scroll', 'preview_wait', 'terminal_read', ...pcMod.PC_NAMES];

// ------------------------------------------------------------------ JSON-RPC / MCP handling
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id: id == null ? null : id, error: { code, message } });
const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result });

const errResult = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

// Never trust whatever the renderer returns: coerce into a valid CallToolResult.
function normalizeResult(r) {
  if (!r || typeof r !== 'object') return { content: [{ type: 'text', text: r == null ? '' : String(r) }] };
  const content = (Array.isArray(r.content) ? r.content : [])
    .map((b) => {
      if (!b || typeof b !== 'object') return null;
      if (b.type === 'image' && b.data) return { type: 'image', data: String(b.data).replace(/^data:[^,]*,/, ''), mimeType: b.mimeType || 'image/png' };
      if (b.type === 'text') return { type: 'text', text: String(b.text == null ? '' : b.text) };
      return null;
    }).filter(Boolean);
  if (!content.length) content.push({ type: 'text', text: r.isError ? 'Error' : 'OK' });
  return r.isError ? { content, isError: true } : { content };
}

// ------------------------------------------------------------------ dynamic extra tools (plugins)
// getExtraTools() -> [{ name, title?, description, inputSchema, readOnly? }]  (called on every tools/list and tools/call, so
// the list can change at runtime). Names that clash with built-ins or are malformed are dropped. Extra tools get lenient
// argument validation (required + declared types; unknown arguments are passed through to the plugin).
function sanitizeExtra(list) {
  const out = [], seen = new Set(TOOL_NAMES);
  for (const t of Array.isArray(list) ? list : []) {
    if (!t || typeof t.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(t.name) || seen.has(t.name)) continue;
    seen.add(t.name);
    const s = t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema) ? t.inputSchema : {};
    const inputSchema = { ...s, type: 'object', properties: s.properties && typeof s.properties === 'object' ? s.properties : {} };
    out.push({ name: t.name, title: t.title || t.name, description: String(t.description || ''), inputSchema, annotations: t.readOnly ? ro : { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } });
  }
  return out;
}
function allTools(getExtra) {
  let extra = [];
  try { extra = sanitizeExtra(typeof getExtra === 'function' ? getExtra() : []); } catch { /* a broken provider must not break the server */ }
  return extra.length ? TOOLS.concat(extra) : TOOLS;
}

function validateArgs(tool, args) {
  const s = tool.inputSchema;
  const lenient = !TOOL_NAMES.includes(tool.name);
  for (const k of s.required || []) if (args[k] === undefined || args[k] === null || args[k] === '') return 'Missing required argument "' + k + '"';
  for (const [k, v] of Object.entries(args)) {
    const p = s.properties[k];
    if (!p) { if (lenient) continue; return 'Unknown argument "' + k + '"'; }
    if (v === null || v === undefined) continue;
    const t = p.type;
    const ok = t === 'string' ? typeof v === 'string' : t === 'boolean' ? typeof v === 'boolean' : t === 'integer' ? Number.isInteger(v)
      : t === 'number' ? typeof v === 'number' : t === 'array' ? Array.isArray(v) : t === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : true;
    if (!ok) return 'Argument "' + k + '" must be ' + t;
    if (p.enum && !p.enum.includes(v)) return 'Argument "' + k + '" must be one of ' + p.enum.join(', ');
  }
  return null;
}

async function callTool(invoke, name, args, getExtra) {
  const tool = allTools(getExtra).find((t) => t.name === name);
  if (!tool) return null; // caller turns this into a protocol error
  args = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  // drop nulls (some clients send explicit nulls for optional args)
  args = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null && v !== undefined));
  const bad = validateArgs(tool, args);
  if (bad) return errResult('Invalid arguments for ' + name + ': ' + bad);
  let timer;
  try {
    const limit = /^pc_/.test(name) ? LONG_TIMEOUT_MS : CALL_TIMEOUT_MS;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('__timeout')), limit); });
    return normalizeResult(await Promise.race([Promise.resolve().then(() => invoke(name, args)), timeout]));
  } catch (e) {
    if (e && e.message === '__timeout') return errResult('The IDE did not answer ' + name + ' within ' + CALL_TIMEOUT_MS / 1000 + ' s (is the preview/terminal panel open and responsive?).');
    return errResult(name + ' failed: ' + (e && e.message ? e.message : String(e)));
  } finally { clearTimeout(timer); }
}

// One JSON-RPC message -> response object, or null for notifications / responses.
async function handleMessage(msg, invoke, getExtra) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return rpcErr(msg && msg.id, -32600, 'Invalid Request');
  const { id, method, params } = msg;
  const isNote = id === undefined || id === null;
  if (typeof method !== 'string') return null; // a response from the client: nothing to do
  switch (method) {
    case 'initialize': {
      const want = params && params.protocolVersion;
      return rpcOk(id, {
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, title: 'Reva IDE', version: SERVER_VERSION },
        instructions: 'Tools to drive the Reva IDE: site preview (open, read, click, type, console, DOM), editor, visible terminal and, with the user\'s permission, Windows apps (pc_*).',
      });
    }
    case 'ping': return isNote ? null : rpcOk(id, {});
    case 'tools/list': return rpcOk(id, { tools: allTools(getExtra) });
    case 'tools/call': {
      const r = await callTool(invoke, params && params.name, params && params.arguments, getExtra);
      return r ? rpcOk(id, r) : rpcErr(id, -32602, 'Unknown tool: ' + (params && params.name));
    }
    case 'resources/list': return rpcOk(id, { resources: [] });
    case 'resources/templates/list': return rpcOk(id, { resourceTemplates: [] });
    case 'prompts/list': return rpcOk(id, { prompts: [] });
    default:
      if (isNote) return null; // notifications/initialized, notifications/cancelled, ...
      return rpcErr(id, -32601, 'Method not found: ' + method);
  }
}

// ------------------------------------------------------------------ HTTP server
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb); // hashing equalises lengths
}

function start({ invoke, token, getExtraTools } = {}) {
  if (typeof invoke !== 'function') return Promise.reject(new Error('ide-mcp.start: invoke is required'));
  token = token || crypto.randomBytes(24).toString('hex');
  let port = 0;
  const sockets = new Set();

  const send = (res, status, body, headers) => {
    const data = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(headers || {}), 'content-length': Buffer.byteLength(data) });
    res.end(data);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname !== '/mcp') return send(res, 404, { error: 'not found' });
      // DNS-rebinding / browser guards
      const host = String(req.headers.host || '').toLowerCase();
      if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) return send(res, 403, { error: 'bad host' });
      if (req.headers.origin) return send(res, 403, { error: 'browser origins are not allowed' });
      const m = /^Bearer (.+)$/i.exec(String(req.headers.authorization || ''));
      if (!m || !safeEqual(m[1], token)) return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });

      if (req.method === 'DELETE') return send(res, 200, '');           // stateless: nothing to terminate
      if (req.method === 'GET') return send(res, 405, { error: 'no server-initiated stream' }, { allow: 'POST, DELETE' });
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST, DELETE' });

      let raw = '', size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) return send(res, 413, { error: 'too large' }); raw += chunk; }
      let msg; try { msg = JSON.parse(raw); } catch { return send(res, 400, rpcErr(null, -32700, 'Parse error')); }

      if (Array.isArray(msg)) { // JSON-RPC batch (2025-03-26 only)
        const out = (await Promise.all(msg.map((x) => handleMessage(x, invoke, getExtraTools)))).filter(Boolean);
        return out.length ? send(res, 200, out) : send(res, 202, '');
      }
      const out = await handleMessage(msg, invoke, getExtraTools);
      if (!out) return send(res, 202, '');
      send(res, 200, out);
    } catch (e) {
      try { send(res, 500, rpcErr(null, -32603, 'Internal error: ' + e.message)); } catch { /* closed */ }
    }
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve({
        url: 'http://127.0.0.1:' + port + '/mcp', port, token,
        close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
      });
    });
  });
}

// ------------------------------------------------------------------ per-agent wiring
const HINT = 'You are running inside the hyper-ide IDE, which exposes its own features as tools (MCP server "hyper-ide"): ' +
  'ide_context (what the user has open/selected), open_file, open_preview (built-in browser preview), terminal_run and terminal_read (visible terminal). ' +
  'To test a web page you can drive the preview WITHOUT screenshots: preview_snapshot (text + numbered interactive elements), preview_click, preview_type, preview_press, preview_hover, preview_scroll, preview_wait, preview_console, preview_html, preview_eval. ' +
  'Use preview_screenshot only when you really need to judge the visual layout. After you build or change a web page or start a dev server, open it with open_preview and check it yourself instead of asking the user to look. ' +
  'You can also see and operate the user\'s PC with the pc_* tools: pc_windows, pc_snapshot (controls as exact text), pc_screenshot (see the desktop; use it for anything without accessible controls), pc_click / pc_type / pc_key / pc_move / pc_scroll / pc_drag, pc_focus, pc_launch, pc_wait. When the user asks you to open, start, find or do something on their computer (an app, a file, a website, a setting), or to test a desktop app you built, do it with these tools instead of explaining how. Check pc_windows first: if the app is already open (even minimized in the taskbar) bring it up with pc_focus (pc_launch does that for you) instead of starting another copy. Never type commands into Win+R or a terminal to start apps (use pc_launch), keep keyboard use to a minimum, and prefer pc_snapshot + refs over pixel coordinates. You never use the user\'s mouse: you have your own AI cursor (clicks are injected as touch), and the same goes for testing the apps you build. The user sees a purple AI cursor and is asked for permission by hyper-ide; if they deny, respect it. ' +
  'Use ide_context when the user says "this file" or "the selection"; use open_file to show them a file.';

/** Merge an OPENCODE_CONFIG_CONTENT fragment into an existing inline config (JSON string or object) -> JSON string. */
function mergeInlineConfig(existing, fragment) {
  let base = {};
  if (typeof existing === 'string') { try { base = JSON.parse(existing) || {}; } catch { base = {}; } }
  else if (existing && typeof existing === 'object') base = existing;
  let frag = fragment;
  if (typeof frag === 'string') { try { frag = JSON.parse(frag); } catch { frag = {}; } }
  const merge = (a, b) => {
    const o = { ...a };
    for (const [k, v] of Object.entries(b || {})) {
      o[k] = v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? merge(o[k], v) : v;
    }
    return o;
  };
  return JSON.stringify(merge(base, frag));
}

const tomlStr = (s) => JSON.stringify(String(s)); // JSON string syntax is valid TOML basic-string syntax

function agentConfig(provider, info, opts = {}) {
  const o = { enabled: true, readOnlyAutoAllow: true, ...opts };
  if (o.enabled === false || !info || !info.url || !info.token) return { hint: '' };
  const prov = String(provider || '').toLowerCase();
  const out = { hint: HINT };
  const SAFE = SAFE_TOOLS.concat(Array.isArray(o.extraSafeTools) ? o.extraSafeTools.filter((n) => typeof n === 'string') : []); // read-only plugin tools may skip the confirmation

  if (prov === 'claude') {
    const cfg = { mcpServers: { [SERVER_NAME]: { type: 'http', url: info.url, headers: { Authorization: 'Bearer ' + info.token } } } };
    out.args = ['--mcp-config', JSON.stringify(cfg)];
    if (o.readOnlyAutoAllow) {
      out.allowedTools = SAFE.map((t) => 'mcp__' + SERVER_NAME + '__' + t);
      out.args.push('--allowedTools', ...out.allowedTools);
    }
    return out;
  }

  if (prov === 'codex') {
    const k = 'mcp_servers.' + SERVER_NAME;
    out.env = { HYPER_IDE_TOKEN: info.token };
    out.configArgs = ['-c', k + '.url=' + tomlStr(info.url), '-c', k + '.bearer_token_env_var="HYPER_IDE_TOKEN"',
      '-c', k + '.startup_timeout_sec=15', '-c', k + '.tool_timeout_sec=180',
      // Codex does NOT ask about MCP tools by default (verified: even in "untrusted" mode). "prompt" makes every tool
      // raise an mcpServer/elicitation/request (codex_approval_kind: mcp_tool_call); the per-tool "approve" below
      // then exempts the safe ones, so only terminal_run / preview_eval still prompt.
      '-c', k + '.default_tools_approval_mode="prompt"'];
    if (o.readOnlyAutoAllow) for (const t of SAFE) out.configArgs.push('-c', k + '.tools.' + t + '.approval_mode="approve"');
    return out;
  }

  if (prov === 'opencode' || prov.startsWith('custom')) {
    out.inlineConfig = { mcp: { [SERVER_NAME]: { type: 'remote', url: info.url, headers: { Authorization: 'Bearer ' + info.token }, enabled: true, timeout: 30000 } } };
    // OpenCode asks for nothing in its default "ask" mode for MCP tools unless permission rules say so; see caveats in report.
    return out;
  }
  return { hint: '' };
}

module.exports = { start, agentConfig, mergeInlineConfig, TOOLS, SERVER_NAME, SAFE_TOOLS, TOOL_NAMES };
