// Custom agents: user-defined agents that speak the same Claude-shaped event protocol as the built-in ones.
//
//   start(opts, hooks)  -> { write(obj), kill() }     dispatches on opts.custom.type
//   describe(def)       -> { id, name, type, models, efforts, modes }   what the UI needs to render the picker
//   listModels(def)     -> Promise<[{id}]>            GET {baseUrl}/models   (api kind)
//   testConnection(def) -> Promise<{ok, models?, error?, ms}>           10 s timeout (api kind)
//
// Two kinds of definition (opts.custom):
//   api: { id, name, type:'api', protocol:'openai'|'anthropic', baseUrl, apiKey, models:[ids], defaultModel, headers? }
//        Runs through OpenCode (full coding-agent tool set) with an INLINE provider config passed in the
//        OPENCODE_CONFIG_CONTENT env var. Nothing is written to disk; the key travels only through the child's
//        environment (config refers to it as "{env:REVA_CUSTOM_API_KEY}").
//   cli: { id, name, type:'cli', command, args:[...], promptVia:'arg'|'stdin', cwdMode:'workspace', env:{...} }
//        One process per user message; stdout is streamed as assistant text.
//        args may contain {prompt} (the user message) and {history} (previous conversation as plain text).
'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const inst = require('./installer');

const KEY_ENV = 'REVA_CUSTOM_API_KEY';
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
const strEnv = (o) => { const r = {}; if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (k && v != null) r[k] = String(v); return r; };

// Pull the plain text out of a Claude-style user message ({content: string | blocks[]}).
function messageText(msg) {
  const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content || '') }];
  return blocks.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n').trim();
}

// ================================================================== API kind (OpenCode + inline provider)

// Provider id used inside OpenCode: stable and filesystem/CLI safe.
const providerId = (def) => 'custom-' + String(def.id || def.name || 'x').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');

// The value of OPENCODE_CONFIG_CONTENT. Shape (verified against opencode 2.0.27):
//   { provider: { "custom-<id>": { npm, name, options:{baseURL, apiKey:"{env:...}", headers?}, models:{<id>:{name}} } },
//     enabled_providers:["custom-<id>"], model:"custom-<id>/<m>", small_model:"custom-<id>/<m>" }
// enabled_providers keeps OpenCode from touching any other provider; small_model stops its title generator
// from going to a different (default) provider with the user's prompt.
function buildInlineConfig(def, model) {
  const pid = providerId(def);
  const ids = (def.models && def.models.length ? def.models : [model]).filter(Boolean);
  if (model && !ids.includes(model)) ids.push(model); // a model missing from the map is "ProviderModelNotFound"
  const models = {};
  for (const m of ids) models[m] = { name: m };
  const options = { baseURL: String(def.baseUrl || '').replace(/\/+$/, ''), apiKey: '{env:' + KEY_ENV + '}' };
  if (def.headers && Object.keys(def.headers).length) options.headers = strEnv(def.headers);
  const ref = pid + '/' + model;
  return {
    $schema: 'https://opencode.ai/config.json',
    enabled_providers: [pid],
    provider: { [pid]: { npm: def.protocol === 'anthropic' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible', name: def.name || pid, options, models } },
    model: ref, small_model: ref,
  };
}

function startApi(opts, hooks) {
  const def = opts.custom;
  if (!def.baseUrl) throw new Error('Custom agent "' + (def.name || def.id) + '" has no base URL');
  const model = opts.model || def.defaultModel || (def.models && def.models[0]) || '';
  if (!model) throw new Error('Custom agent "' + (def.name || def.id) + '" has no model');
  const cfg = buildInlineConfig(def, model);
  const baseEnv = strEnv(opts.env);
  // merge (not overwrite) any inline config main.js already put in the env, e.g. the reva-ide MCP server
  const env = { ...baseEnv, OPENCODE_CONFIG_CONTENT: require('../ide-mcp').mergeInlineConfig(baseEnv.OPENCODE_CONFIG_CONTENT, cfg), [KEY_ENV]: String(def.apiKey || 'none') };
  // opencode.js reads opts.custom as the binary-path override; ours is the agent definition, so swap it.
  return require('./opencode').start({ ...opts, custom: opts.opencode || undefined, model: providerId(def) + '/' + model, env }, hooks);
}

// ---- model listing / connection test
function headersFor(def) {
  const h = { accept: 'application/json', ...strEnv(def.headers) };
  if (def.protocol === 'anthropic') { h['x-api-key'] = def.apiKey || ''; h['anthropic-version'] = '2023-06-01'; }
  else if (def.apiKey) h.authorization = 'Bearer ' + def.apiKey;
  return h;
}

// GET url with a timeout -> { status, body (string) }
function httpGet(url, headers, timeout) {
  return new Promise((resolve, reject) => {
    let u; try { u = new URL(url); } catch { return reject(new Error('Invalid URL: ' + url)); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method: 'GET', headers, timeout }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (d) => { if (b.length < 4e6) b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('timeout', () => req.destroy(new Error('Timed out after ' + timeout / 1000 + ' s')));
    req.on('error', reject);
    req.end();
  });
}

async function listModels(def, timeout = 10000) {
  const base = String(def.baseUrl || '').replace(/\/+$/, '');
  const r = await httpGet(base + '/models', headersFor(def), timeout);
  if (r.status < 200 || r.status >= 300) {
    let msg = ''; try { const j = JSON.parse(r.body); msg = (j.error && (j.error.message || j.error)) || j.message || ''; } catch { /* not json */ }
    throw new Error('HTTP ' + r.status + (msg ? ': ' + (typeof msg === 'string' ? msg : JSON.stringify(msg)) : ''));
  }
  let j; try { j = JSON.parse(r.body); } catch { throw new Error('Response is not JSON'); }
  const arr = Array.isArray(j) ? j : Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
  return arr.map((m) => ({ id: typeof m === 'string' ? m : m.id || m.name })).filter((m) => m.id);
}

async function testConnection(def) {
  const t0 = Date.now();
  try { const models = await listModels(def, 10000); return { ok: true, models, ms: Date.now() - t0 }; }
  catch (e) { return { ok: false, error: e.message, ms: Date.now() - t0 }; }
}

// ================================================================== CLI kind

// Strip ANSI CSI/OSC sequences; returns { text, rest } where rest is a trailing incomplete escape to prepend to the next chunk.
function cleanChunk(s) {
  let rest = '';
  const i = s.lastIndexOf('\x1b');
  if (i >= 0 && !/^\x1b(\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(\x07|\x1b\\)|[@-Z\\-_])/.test(s.slice(i))) { rest = s.slice(i); s = s.slice(0, i); }
  s = s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b[@-Z\\-_]/g, '');
  return { text: s.replace(/\r\n/g, '\n').replace(/\r(?!\n)/g, '\n'), rest };
}

// Resolve a user-typed command to a spawn target {cmd, shell, shim?}. Bare names are looked up on the fresh PATH
// (.exe, .cmd, .bat); .cmd/.bat shims are unwrapped to the real exe when possible, else run through cmd.exe.
function resolveCommand(command) {
  command = String(command || '').trim().replace(/^"(.*)"$/, '$1');
  if (!command) return null;
  const hasDir = /[\\/]/.test(command);
  let file = null;
  if (hasDir) { if (fs.existsSync(command)) file = command; else for (const e of ['.exe', '.cmd', '.bat']) if (fs.existsSync(command + e)) { file = command + e; break; } }
  else file = /\.\w+$/.test(command) ? inst.findOnPath(command.replace(/\.\w+$/, ''), [command.match(/\.\w+$/)[0]]) : inst.findOnPath(command);
  if (file) return inst.targetFor(file);
  return { cmd: command, shell: false }; // let spawn report ENOENT
}

// cmd.exe quoting for the shim fallback (newlines flattened: cmd cannot carry them in an argument).
function quoteCmd(a) {
  a = String(a).replace(/\r?\n/g, ' ');
  if (/^[\w@.,:=+\\/-]+$/.test(a)) return a;
  return '"' + a.replace(/%/g, '%%').replace(/"/g, '""') + '"';
}

function startCli(opts, hooks) {
  const def = opts.custom;
  const emit = (ev) => { try { hooks.emit && hooks.emit(ev); } catch { /* never let the UI break us */ } };
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
  const target = resolveCommand(def.command);
  if (!target) throw new Error('Custom agent "' + (def.name || def.id) + '" has no command');
  const model = def.name || def.id || 'cli';
  const S = { sessionId: opts.resume || uuid(), child: null, queue: [], killed: false, transcript: '', turns: 0 };
  emit({ type: 'system', subtype: 'init', session_id: S.sessionId, model, slash_commands: [], mcp_servers: [], tools: [], cwd });

  function runTurn(msg) {
    const prompt = messageText(msg);
    const history = S.transcript.trim();
    const startedAt = Date.now();
    const se = (event) => emit({ type: 'stream_event', event });
    const msgId = 'msg_' + Date.now().toString(36) + S.turns;
    let opened = false, answer = '', rest = '', stderrTail = '', interrupted = false, spawnErr = '';
    const dec = new StringDecoder('utf8');

    const open = () => {
      if (opened) return; opened = true;
      se({ type: 'message_start', message: { id: msgId, role: 'assistant', content: [], model } });
      se({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    };
    const pushText = (t) => { if (!t) return; open(); answer += t; se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }); };
    const closeMsg = () => {
      if (!opened) return; opened = false;
      se({ type: 'content_block_stop', index: 0 });
      emit({ type: 'assistant', message: { id: msgId, type: 'message', role: 'assistant', model, content: [{ type: 'text', text: answer }] } });
      se({ type: 'message_stop' });
    };
    const feed = (str) => { const c = cleanChunk(rest + str); rest = c.rest; pushText(c.text); };

    // Build argv. {prompt}/{history} are substituted inside any argument; with promptVia 'arg' and no {prompt}
    // placeholder the prompt is appended as the last argument.
    const viaStdin = def.promptVia === 'stdin';
    let args = (Array.isArray(def.args) ? def.args : []).map((a) => String(a).split('{history}').join(history).split('{prompt}').join(prompt));
    const hasPh = (Array.isArray(def.args) ? def.args : []).some((a) => String(a).includes('{prompt}'));
    if (!viaStdin && !hasPh) args.push(prompt);

    let child;
    try {
      const env = inst.freshEnv({ ...strEnv(opts.env), ...strEnv(def.env) });
      child = target.shell
        ? spawn('"' + target.cmd + '" ' + args.map(quoteCmd).join(' '), [], { cwd, env, shell: true, windowsHide: true })
        : spawn(target.cmd, args, { cwd, env, windowsHide: true });
    } catch (e) { return finish(-1, e.message); }
    S.child = child;

    child.stdout.on('data', (d) => feed(dec.write(d)));
    child.stderr.on('data', (d) => {
      const s = cleanChunk(d.toString('utf8')).text;
      stderrTail = (stderrTail + s).slice(-2000);
      if (s.trim()) emit({ type: 'stderr', text: s });
    });
    child.stdin.on('error', () => { });
    child.stdin.end(viaStdin ? prompt : undefined);
    child.on('error', (e) => { spawnErr = e.code === 'ENOENT' ? 'Command not found: ' + def.command : e.message; });
    child.on('close', (code) => finish(code, spawnErr));
    S.cancel = () => { interrupted = true; };

    function finish(code, errText) {
      S.child = null; S.cancel = null;
      if (child) { feed(dec.end()); if (rest) { pushText(rest.replace(/\x1b/g, '')); rest = ''; } }
      closeMsg();
      if (S.killed) return;
      S.turns++;
      // transcript is kept even for failed turns so the model of the conversation stays consistent
      S.transcript += (S.transcript ? '\n\n' : '') + 'User: ' + prompt + (answer.trim() ? '\n\nAssistant: ' + answer.trim() : '');
      const failed = !interrupted && (code !== 0 || !!errText);
      const result = { type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed, session_id: S.sessionId, duration_ms: Date.now() - startedAt, total_cost_usd: 0, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0 } };
      if (failed) result.result = errText || stderrTail.trim().split('\n').slice(-12).join('\n') || (def.command + ' exited with code ' + code);
      else if (interrupted) result.result = 'Interrupted';
      emit(result);
      next();
    }
  }
  function next() { if (S.killed) return; const m = S.queue.shift(); if (m) runTurn(m); }

  return {
    write(obj) {
      if (S.killed || !obj) return false;
      if (obj.type === 'user' && obj.message) { if (S.child) S.queue.push(obj.message); else runTurn(obj.message); return true; }
      if (obj.type === 'control_request' && obj.request && obj.request.subtype === 'interrupt') {
        S.queue.length = 0;
        if (S.child) { if (S.cancel) S.cancel(); inst.killTree(S.child.pid); }
        return true;
      }
      return false; // control_response: a plain CLI has no permission round-trip
    },
    kill() { S.killed = true; S.queue.length = 0; if (S.child) inst.killTree(S.child.pid); },
  };
}

// ================================================================== public API
function start(opts = {}, hooks = {}) {
  const def = opts.custom;
  if (!def || typeof def !== 'object') throw new Error('start: opts.custom (agent definition) is required');
  if (def.type === 'api') return startApi(opts, hooks);
  if (def.type === 'cli') return startCli(opts, hooks);
  throw new Error('Unknown custom agent type: ' + def.type);
}

function describe(def) {
  const base = { id: def.id, name: def.name || def.id, type: def.type };
  if (def.type === 'api') {
    const models = [...new Set([def.defaultModel, ...(def.models || [])].filter(Boolean))];
    return { ...base, models, efforts: [], modes: [{ value: 'ask', label: 'Ask' }, { value: 'auto', label: 'Auto' }] };
  }
  return { ...base, models: [], efforts: [], modes: [{ value: 'default', label: 'Run' }] };
}

module.exports = { start, listModels, testConnection, describe, buildInlineConfig, providerId, cleanChunk, resolveCommand };
