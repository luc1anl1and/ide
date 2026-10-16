'use strict';
// Codex CLI adapter: speaks the `codex app-server` JSON-RPC protocol (newline-delimited, stdio)
// and translates it into Claude-Code stream-json shaped events for the Reva renderer.
//   start(opts, hooks) -> { write(obj), kill(), rewind(keepTurns) }   opts.reasoningSummary: 'auto'|'concise'|'detailed'(default)|'none'
//   rewindSession(custom, threadId, keepTurns, {env, cwd}) -> Promise<{ok, error?, filesReverted?, filesSkipped?, note?}>
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------- locating codex
function findExeNear(dir) {
  try {
    const hit = fs.readdirSync(dir).find((f) => /^codex(-.*windows-msvc)?\.exe$/i.test(f));
    return hit ? path.join(dir, hit) : null;
  } catch { return null; }
}
/** -> {exe, viaShell} | null. `viaShell` means exe is a .cmd/.bat shim that must be spawned with shell:true. */
function resolveCodex(custom) {
  const shim = (p) => ({ exe: p, viaShell: /\.(cmd|bat)$/i.test(p) });
  if (custom && fs.existsSync(custom)) return shim(custom);
  const cands = [];
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['codex'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    cands.push(...out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  } catch { /* not on PATH */ }
  if (process.env.APPDATA) cands.push(path.join(process.env.APPDATA, 'npm', 'codex.cmd'));
  for (const c of cands) {
    if (!fs.existsSync(c)) continue;
    if (/\.exe$/i.test(c)) return shim(c);
    const near = findExeNear(path.dirname(c)); // winget layout: real exe sits next to the codex.cmd wrapper
    if (near) return shim(near);
    if (/\.(cmd|bat)$/i.test(c)) return shim(c);
  }
  return null;
}
function spawnCodex(r, args, opts) {
  return spawn(r.exe, args, { windowsHide: true, shell: !!r.viaShell, ...opts });
}
function killTree(p) {
  if (!p || p.exitCode != null) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
    else p.kill('SIGKILL');
  } catch { try { p.kill(); } catch { /* gone */ } }
}

// ---------------------------------------------------------------- JSON-RPC client over a child process
class Rpc {
  constructor(proc, onNote, onRequest, onStderr) {
    this.p = proc; this.id = 0; this.pend = new Map(); this.buf = '';
    this.onNote = onNote; this.onRequest = onRequest;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      this.buf += d; let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        this._dispatch(j);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (d) => onStderr && onStderr(d));
    proc.stdin.on('error', () => { });
    proc.on('close', () => { for (const [, r] of this.pend) r({ error: { message: 'codex process exited' } }); this.pend.clear(); });
  }
  _dispatch(j) {
    if (j.method && j.id != null) { if (this.onRequest) this.onRequest(j); }
    else if (j.method) { if (this.onNote) this.onNote(j.method, j.params || {}); }
    else if (j.id != null && this.pend.has(j.id)) { const r = this.pend.get(j.id); this.pend.delete(j.id); r(j); }
  }
  _send(o) { try { this.p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n'); } catch { /* process gone */ } }
  /** resolves {result} or {error}; never rejects */
  req(method, params) { return new Promise((res) => { const id = ++this.id; this.pend.set(id, res); this._send({ id, method, params }); }); }
  note(method, params) { this._send(params === undefined ? { method } : { method, params }); }
  respond(id, result) { this._send({ id, result }); }
  respondError(id, code, message) { this._send({ id, error: { code, message } }); }
  async handshake() {
    const r = await this.req('initialize', { clientInfo: { name: 'hyper-ide', title: 'hyper-ide', version: '0.9' }, capabilities: { experimentalApi: true } });
    if (!r.error) this.note('initialized');
    return r;
  }
}

// ---------------------------------------------------------------- shared helpers
const windowLabel = (mins) => {
  if (!mins) return '';
  if (mins === 300) return '5h';
  if (mins === 10080) return 'Weekly';
  if (mins % 1440 === 0) return mins / 1440 + 'd';
  if (mins % 60 === 0) return mins / 60 + 'h';
  return mins + 'm';
};
/** RateLimitSnapshot (+ credits) -> usage_event shape (without the `type` field). */
function usageFrom(snap) {
  if (!snap) return null;
  const windows = [];
  for (const id of ['primary', 'secondary']) {
    const w = snap[id]; if (!w) continue;
    windows.push({ id, label: windowLabel(w.windowDurationMins) || (id === 'primary' ? 'Session' : 'Weekly'), usedPct: w.usedPercent, resetsAt: w.resetsAt || null });
  }
  const c = snap.credits;
  return { provider: 'codex', plan: snap.planType || null, windows, credits: c ? { hasCredits: !!c.hasCredits, unlimited: !!c.unlimited, balance: c.balance == null ? null : c.balance } : null };
}
// UI mode -> Codex thread settings. `ask` uses `untrusted` so file edits/commands really prompt;
// `auto` is Codex's own "Auto" preset (workspace-write + on-request).
const MODES = {
  readonly: { sandbox: 'read-only', approvalPolicy: 'on-request' },
  ask: { sandbox: 'workspace-write', approvalPolicy: 'untrusted' },
  auto: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
  full: { sandbox: 'danger-full-access', approvalPolicy: 'never' },
};
const SUMMARY_MODES = new Set(['auto', 'concise', 'detailed', 'none']);
const textOf = (content) => (Array.isArray(content) ? content.map((x) => (x && x.type === 'text' ? x.text : x && x.text) || '').filter(Boolean).join('\n') : String(content == null ? '' : content));

/** Derive Edit-style old/new strings from a unified-diff body (single or multi hunk). */
function diffToOldNew(diff) {
  const oldL = [], newL = []; let seenHunk = false;
  for (const l of String(diff).split('\n')) {
    if (/^(---|\+\+\+) /.test(l) && !seenHunk) continue;
    if (l.startsWith('@@')) { seenHunk = true; if (oldL.length || newL.length) { oldL.push('...'); newL.push('...'); } continue; }
    if (l.startsWith('\\')) continue;
    if (l.startsWith('-')) oldL.push(l.slice(1));
    else if (l.startsWith('+')) newL.push(l.slice(1));
    else if (l.startsWith(' ')) { oldL.push(l.slice(1)); newL.push(l.slice(1)); }
  }
  return { old_string: oldL.join('\n'), new_string: newL.join('\n') };
}
/** fileChange item -> {name, input} */
function fileChangeTool(changes) {
  const ch = changes || [];
  if (ch.length === 1) {
    const c = ch[0], kind = c.kind && c.kind.type;
    if (kind === 'update' && !(c.kind.move_path)) return { name: 'Edit', input: { file_path: c.path, ...diffToOldNew(c.diff) } };
    if (kind === 'add') return { name: 'Write', input: { file_path: c.path, content: /^(@@|\+\+\+|---)/m.test(c.diff) ? diffToOldNew(c.diff).new_string : c.diff } };
  }
  const patch = ch.map((c) => `*** ${(c.kind && c.kind.type) || 'update'}: ${c.path}${c.kind && c.kind.move_path ? ' -> ' + c.kind.move_path : ''}\n${c.diff}`).join('\n');
  return { name: 'ApplyPatch', input: { patch } };
}

// ---------------------------------------------------------------- the chat session
function start(opts, hooks) {
  opts = opts || {};
  const emit = (ev) => { try { hooks.emit(ev); } catch { /* renderer gone */ } };
  const resolved = resolveCodex(opts.custom);
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
  const imgDir = path.join(os.tmpdir(), 'reva-img', String(opts.id || process.pid) + '-' + Date.now().toString(36));
  const tmpFiles = [];

  let rpc = null, proc = null, dead = false, ready = false, rewinding = false;
  let readyDone; const readyP = new Promise((r) => { readyDone = r; }); // settles once the thread exists (or boot failed)
  let threadId = null, turnId = null, busy = false, interruptWanted = false;
  let turnStartedAt = 0, usageAtTurnStart = null, lastTotal = null;
  const queue = [];           // user messages (rendered input arrays) waiting for a turn slot
  const early = [];           // write() calls before the thread exists
  const pending = new Map();  // our request_id -> {rpcId, kind, params}
  const items = new Map();    // itemId -> {msgId, toolName, started, text, thinkIdx, ...}
  let reqSeq = 0;

  const msgId = (itemId) => 'cx-' + itemId;
  const fail = (text) => { emit({ type: 'stderr', text }); };

  // ---- Claude-shaped emitters
  const streamStart = (id) => emit({ type: 'stream_event', event: { type: 'message_start', message: { id } } });
  const blockStart = (index, block) => emit({ type: 'stream_event', event: { type: 'content_block_start', index, content_block: block } });
  const blockDelta = (index, delta) => emit({ type: 'stream_event', event: { type: 'content_block_delta', index, delta } });
  const assistant = (id, content) => emit({ type: 'assistant', message: { id, role: 'assistant', content } });
  const toolUse = (id, name, input) => { assistant(msgId(id), [{ type: 'tool_use', id, name, input }]); };
  const toolResult = (id, content, isErr) => emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: !!isErr }] } });

  // ---- item lifecycle
  function onItemStarted(item) {
    const st = { msgId: msgId(item.id), type: item.type, text: '', summary: [], lastSummaryIdx: -1, toolEmitted: false };
    items.set(item.id, st);
    switch (item.type) {
      case 'agentMessage': streamStart(st.msgId); blockStart(0, { type: 'text', text: '' }); break;
      case 'reasoning': break; // the thinking block is opened lazily by the first summary/raw delta (no empty blocks when summaries are off)
      case 'commandExecution':
        st.toolEmitted = true; st.name = 'Bash'; st.input = { command: item.command, cwd: item.cwd };
        toolUse(item.id, 'Bash', st.input); break;
      case 'fileChange':
        if (item.changes && item.changes.length) { const t = fileChangeTool(item.changes); st.name = t.name; st.input = t.input; st.toolEmitted = true; toolUse(item.id, t.name, t.input); }
        break; // otherwise defer until completion, when the diff is known
      case 'mcpToolCall':
        st.toolEmitted = true; st.name = `mcp__${item.server}__${item.tool}`; st.input = item.arguments && typeof item.arguments === 'object' ? item.arguments : { arguments: item.arguments };
        toolUse(item.id, st.name, st.input); break;
      case 'webSearch': st.toolEmitted = true; st.name = 'WebSearch'; st.input = { query: item.query || '' }; toolUse(item.id, 'WebSearch', st.input); break;
      case 'dynamicToolCall': st.toolEmitted = true; st.name = item.tool; st.input = item.arguments && typeof item.arguments === 'object' ? item.arguments : {}; toolUse(item.id, st.name, st.input); break;
      default: break;
    }
  }
  function onItemCompleted(item) {
    let st = items.get(item.id);
    if (!st) { onItemStarted(item); st = items.get(item.id); } // never saw the start (or it was skipped)
    switch (item.type) {
      case 'agentMessage': {
        const text = item.text || st.text;
        if (!st.streamed && text) blockDelta(0, { type: 'text_delta', text }); // fallback: no deltas arrived
        assistant(st.msgId, [{ type: 'text', text }]); break;
      }
      case 'plan': streamStart(st.msgId); assistant(st.msgId, [{ type: 'text', text: item.text }]); break;
      case 'reasoning': {
        const body = (item.summary && item.summary.length ? item.summary : item.content || []).join('\n\n') || st.text;
        if (!body.trim() && !st.thinkOpen) break; // nothing was shown (summaries off / not produced)
        if (!st.thinkOpen) { streamStart(st.msgId); blockStart(0, { type: 'thinking', thinking: '' }); blockDelta(0, { type: 'thinking_delta', thinking: body }); }
        assistant(st.msgId, [{ type: 'thinking', thinking: body }]); break;
      }
      case 'commandExecution': {
        const out = item.aggregatedOutput == null ? st.out || '' : item.aggregatedOutput;
        const bad = item.status === 'failed' || item.status === 'declined' || (item.exitCode != null && item.exitCode !== 0);
        const note = item.status === 'declined' ? 'Command was declined.' : item.exitCode ? `exit code ${item.exitCode}` : '';
        toolResult(item.id, [out, note].filter(Boolean).join('\n') || '(no output)', bad); break;
      }
      case 'fileChange': {
        const t = fileChangeTool(item.changes);
        if (!st.toolEmitted) { st.name = t.name; st.toolEmitted = true; }
        toolUse(item.id, st.name || t.name, t.input); // re-emit: renderer updates the input of an existing card
        const bad = item.status === 'failed' || item.status === 'declined';
        toolResult(item.id, bad ? `Patch ${item.status}.` : (item.changes || []).map((c) => `${(c.kind && c.kind.type) || 'update'} ${c.path}`).join('\n') || 'Applied.', bad); break;
      }
      case 'mcpToolCall': {
        const err = item.error && item.error.message;
        const res = item.result ? textOf(item.result.content) || (item.result.structuredContent ? JSON.stringify(item.result.structuredContent) : '') : '';
        toolResult(item.id, err || res || '(no output)', !!err || item.status === 'failed'); break;
      }
      case 'webSearch':
        if (item.query && st.input && !st.input.query) { st.input.query = item.query; toolUse(item.id, 'WebSearch', st.input); }
        toolResult(item.id, 'Search completed.', false); break;
      case 'dynamicToolCall': toolResult(item.id, textOf((item.contentItems || []).map((c) => ({ type: 'text', text: c.text }))) || '(no output)', item.success === false); break;
      default: break;
    }
    items.delete(item.id);
  }

  // ---- notifications
  function onNote(method, p) {
    switch (method) {
      case 'turn/started': turnId = p.turn && p.turn.id; if (interruptWanted) doInterrupt(); break;
      case 'item/started': onItemStarted(p.item); break;
      case 'item/completed': onItemCompleted(p.item); break;
      case 'item/agentMessage/delta': {
        const st = items.get(p.itemId); if (!st) break;
        st.text += p.delta; st.streamed = true; blockDelta(0, { type: 'text_delta', text: p.delta }); break;
      }
      case 'item/reasoning/summaryTextDelta': case 'item/reasoning/textDelta': {
        const st = items.get(p.itemId); if (!st) break;
        // Prefer the summary stream; ignore raw text if summaries are flowing
        if (method.endsWith('textDelta') && !method.includes('summary') && st.sawSummary) break;
        if (!st.thinkOpen) { st.thinkOpen = true; streamStart(st.msgId); blockStart(0, { type: 'thinking', thinking: '' }); }
        if (method.includes('summary')) {
          st.sawSummary = true;
          if (st.lastSummaryIdx !== -1 && p.summaryIndex !== st.lastSummaryIdx) { st.text += '\n\n'; blockDelta(0, { type: 'thinking_delta', thinking: '\n\n' }); }
          st.lastSummaryIdx = p.summaryIndex;
        }
        st.text += p.delta; blockDelta(0, { type: 'thinking_delta', thinking: p.delta }); break;
      }
      case 'item/commandExecution/outputDelta': { const st = items.get(p.itemId); if (st) st.out = (st.out || '') + p.delta; break; }
      case 'turn/plan/updated': {
        const todos = (p.plan || []).map((s) => ({ content: s.step, status: s.status === 'inProgress' ? 'in_progress' : s.status, activeForm: s.step }));
        const id = 'cx-plan-' + p.turnId;
        toolUse(id, 'TodoWrite', { todos }); toolResult(id, 'Plan updated.', false); break;
      }
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage, f = (b) => b && ({ input: b.inputTokens, output: b.outputTokens, cached: b.cachedInputTokens, reasoning: b.reasoningOutputTokens, total: b.totalTokens });
        lastTotal = f(u.total);
        emit({ type: 'token_usage', provider: 'codex', total: f(u.total), contextWindow: u.modelContextWindow || null, last: f(u.last) }); break;
      }
      case 'account/rateLimits/updated': { const u = usageFrom(p.rateLimits); if (u) emit({ type: 'usage_event', ...u }); break; }
      case 'error': fail((p.error && p.error.message) + (p.willRetry ? ' (retrying)' : '')); break;
      case 'warning': if (p.message) fail(p.message); break;
      case 'turn/completed': onTurnDone(p.turn || {}); break;
      default: break;
    }
  }
  function onTurnDone(turn) {
    const failed = turn.status === 'failed';
    const t = lastTotal || {}, b = usageAtTurnStart || {};
    const d = (k) => Math.max(0, (t[k] || 0) - (b[k] || 0));
    busy = false; turnId = null; interruptWanted = false; items.clear();
    emit({
      type: 'result', subtype: failed ? 'error_during_execution' : 'success', is_error: failed,
      ...(failed ? { result: (turn.error && turn.error.message) || 'Turn failed' } : turn.status === 'interrupted' ? { result: 'Interrupted' } : {}),
      duration_ms: turn.durationMs != null ? turn.durationMs : Date.now() - turnStartedAt, total_cost_usd: 0, num_turns: 1,
      usage: { input_tokens: d('input'), output_tokens: d('output'), cached_input_tokens: d('cached'), reasoning_tokens: d('reasoning') },
    });
    pump();
  }

  // ---- server -> client requests (approvals etc.)
  function ask(rpcId, kind, params, toolName, input, description, suggestions) {
    const request_id = 'cx-req-' + (++reqSeq) + '-' + Date.now().toString(36);
    pending.set(request_id, { rpcId, kind, params });
    emit({ type: 'control_request', request_id, request: { subtype: 'can_use_tool', tool_name: toolName, input, description: description || '', permission_suggestions: suggestions || [] } });
  }
  const SESSION_SUGGESTION = [{ type: 'setMode', mode: 'session', destination: 'session' }]; // makes the UI show "Always allow"
  function onRequest(j) {
    const p = j.params || {}, id = j.id;
    switch (j.method) {
      case 'item/commandExecution/requestApproval': {
        const st = items.get(p.itemId);
        ask(id, 'command', p, 'Bash', { command: p.command || (st && st.input && st.input.command) || '', cwd: p.cwd || undefined, ...(p.networkApprovalContext ? { network: p.networkApprovalContext } : {}) }, p.reason, SESSION_SUGGESTION); break;
      }
      case 'item/fileChange/requestApproval': {
        const st = items.get(p.itemId);
        ask(id, 'file', p, (st && st.name) || 'Edit', (st && st.input) || { grantRoot: p.grantRoot || undefined }, p.reason || (p.grantRoot ? 'Write access to ' + p.grantRoot : ''), SESSION_SUGGESTION); break;
      }
      case 'item/permissions/requestApproval':
        ask(id, 'permissions', p, 'Permissions', { permissions: p.permissions, cwd: p.cwd }, p.reason, SESSION_SUGGESTION); break;
      case 'item/tool/requestUserInput':
        ask(id, 'userInput', p, 'AskUserQuestion', {
          questions: (p.questions || []).map((q) => ({ question: q.question, header: q.header, multiSelect: false, options: (q.options || []).map((o) => ({ label: o.label, description: o.description || '' })) })),
        }, ''); break;
      case 'mcpServer/elicitation/request': {
        const { threadId: _t, turnId: _u, ...rest } = p;
        ask(id, 'elicitation', p, `mcp__${p.serverName}__elicitation`, rest, p.message || ''); break;
      }
      default: rpc.respondError(id, -32601, 'Method not supported by hyper-ide: ' + j.method);
    }
  }
  function onControlResponse(msg) {
    const r = msg.response || {}, pr = pending.get(r.request_id);
    if (!pr) return;
    pending.delete(r.request_id);
    const body = r.response || {}, allow = r.subtype === 'success' && body.behavior === 'allow';
    const remember = allow && Array.isArray(body.updatedPermissions) && body.updatedPermissions.length > 0;
    let result;
    switch (pr.kind) {
      case 'command': case 'file': result = { decision: allow ? (remember ? 'acceptForSession' : 'accept') : 'decline' }; break;
      case 'permissions': result = allow ? { permissions: pr.params.permissions, scope: remember ? 'session' : 'turn' } : { permissions: {} }; break;
      case 'userInput': {
        const answers = {}, given = (body.updatedInput && body.updatedInput.answers) || {};
        if (allow) for (const q of pr.params.questions || []) if (given[q.question] != null && given[q.question] !== '') answers[q.id] = { answers: String(given[q.question]).split(', ') };
        result = { answers }; break;
      }
      case 'elicitation': result = allow ? { action: 'accept', content: (body.updatedInput && body.updatedInput.content) || {} } : { action: 'decline' }; break;
      default: result = {};
    }
    rpc.respond(pr.rpcId, result);
  }

  // ---- turns
  function toInput(content) {
    const input = [];
    for (const b of Array.isArray(content) ? content : [{ type: 'text', text: String(content) }]) {
      if (b.type === 'image' && b.source && b.source.data) {
        // localImage path input is the most broadly supported; files live under tmpdir and are removed on kill()
        const ext = /png/i.test(b.source.media_type) ? 'png' : /jpe?g/i.test(b.source.media_type) ? 'jpg' : /gif/i.test(b.source.media_type) ? 'gif' : /webp/i.test(b.source.media_type) ? 'webp' : 'png';
        try {
          fs.mkdirSync(imgDir, { recursive: true });
          const f = path.join(imgDir, `img${tmpFiles.length}.${ext}`);
          fs.writeFileSync(f, Buffer.from(b.source.data, 'base64')); tmpFiles.push(f);
          input.push({ type: 'localImage', path: f });
        } catch (e) { fail('Could not attach image: ' + e.message); }
      } else if (b.type === 'text' && b.text) input.push({ type: 'text', text: b.text, text_elements: [] });
    }
    return input;
  }
  async function startTurn(input) {
    busy = true; turnStartedAt = Date.now(); usageAtTurnStart = lastTotal;
    // `summary` is what makes Codex stream reasoning summaries at all (default for the model is often 'none'/'auto' with
    // no text). 'detailed' by default; opts.reasoningSummary: 'auto' | 'concise' | 'detailed' | 'none'.
    const params = { threadId, input, ...(opts.model ? { model: opts.model } : {}), ...(opts.effort ? { effort: opts.effort } : {}), summary: SUMMARY_MODES.has(opts.reasoningSummary) ? opts.reasoningSummary : 'detailed' };
    const r = await rpc.req('turn/start', params);
    if (r.error) {
      busy = false; turnId = null;
      fail('turn/start failed: ' + r.error.message);
      emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: r.error.message, duration_ms: Date.now() - turnStartedAt, total_cost_usd: 0, num_turns: 1, usage: {} });
      return;
    }
    if (r.result && r.result.turn && !turnId) turnId = r.result.turn.id;
    if (interruptWanted && turnId) doInterrupt();
  }
  async function steer(input) {
    const r = await rpc.req('turn/steer', { threadId, expectedTurnId: turnId, input });
    if (r.error) { queue.push(input); } // turn probably ended meanwhile; send as a fresh turn
  }
  function pump() { if (!busy && !rewinding && ready && !dead && queue.length) startTurn(queue.shift()); }
  function doInterrupt() {
    if (!turnId) { interruptWanted = true; return; }
    interruptWanted = false;
    rpc.req('turn/interrupt', { threadId, turnId });
  }
  function submit(content) {
    const input = toInput(content);
    if (!input.length) return;
    if (busy && turnId && !rewinding) steer(input); else { queue.push(input); pump(); }
  }

  function write(obj) {
    if (dead || !obj) return false;
    if (!ready) { early.push(obj); return true; }
    if (obj.type === 'user') submit(obj.message && obj.message.content);
    else if (obj.type === 'control_request' && obj.request && obj.request.subtype === 'interrupt') { queue.length = 0; if (busy) doInterrupt(); }
    else if (obj.type === 'control_response') onControlResponse(obj);
    return true;
  }
  function cleanup() {
    for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
    try { fs.rmSync(imgDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  function kill() { dead = true; killed = true; killTree(proc); cleanup(); }

  // Undo: keep the first `keepTurns` user turns. Conversation via thread/revert, files best-effort from the
  // reverted turns' fileChange items (see rewindThread). Only legal between turns.
  async function rewind(keepTurns) {
    if (!ready) await readyP;
    if (dead || !ready || !threadId) return { ok: false, error: 'Session is not running' };
    if (busy || queue.length || rewinding || pending.size) return { ok: false, error: 'A turn is running; stop it before undoing' };
    rewinding = true;
    try { return await rewindThread(rpc, threadId, keepTurns, cwd); }
    finally { rewinding = false; pump(); } // messages written during the rewind run now, on the truncated thread
  }

  // ---- boot
  if (!resolved) {
    setImmediate(() => { fail('Codex CLI not found. Install it (winget install OpenAI.Codex) or set its path in Settings.'); hooks.exit(127, 'codex not found'); });
    return { write: () => false, kill: () => { }, rewind: async () => ({ ok: false, error: 'Codex CLI not found' }) };
  }
  try { proc = spawnCodex(resolved, ['--no-daemon', ...(opts.configArgs || []), 'app-server'], { cwd, env: mergeEnv(opts.env) }); }
  catch (e) { setImmediate(() => hooks.exit(1, e.message)); return { write: () => false, kill: () => { }, rewind: async () => ({ ok: false, error: e.message }) }; }
  let errTail = '', killed = false;
  proc.on('error', (e) => { errTail = e.message; });
  proc.on('close', (code) => { const k = killed; dead = true; readyDone(); cleanup(); k ? hooks.exit(0) : hooks.exit(code, code ? errTail.trim().slice(-400) : undefined); });
  rpc = new Rpc(proc, onNote, onRequest, (d) => { errTail = (errTail + d).slice(-2000); });

  (async () => {
    const init = await rpc.handshake();
    if (init.error) { fail('Codex handshake failed: ' + init.error.message); kill(); return; }
    const m = MODES[opts.mode] || MODES.ask;
    const common = { cwd, approvalPolicy: m.approvalPolicy, sandbox: m.sandbox, ...(opts.model ? { model: opts.model } : {}) };
    let r = null;
    if (opts.resume) {
      r = await rpc.req('thread/resume', { threadId: opts.resume, excludeTurns: true, ...common });
      if (r.error) { fail('Could not resume Codex thread (' + r.error.message + '); starting a new one.'); r = null; }
    }
    if (!r) r = await rpc.req('thread/start', common);
    if (r.error || !r.result) { fail('thread/start failed: ' + ((r.error && r.error.message) || 'no result')); emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: (r.error && r.error.message) || 'thread/start failed', duration_ms: 0, total_cost_usd: 0, num_turns: 0, usage: {} }); readyDone(); return; }
    threadId = r.result.thread.id;
    ready = true; readyDone();
    emit({ type: 'system', subtype: 'init', session_id: threadId, model: r.result.model || opts.model || '', slash_commands: [], cwd });
    rpc.req('account/rateLimits/read', null).then((u) => { const x = u.result && usageFrom(u.result.rateLimits); if (x) emit({ type: 'usage_event', ...x }); });
    while (early.length) write(early.shift());
  })();

  return { write, kill, rewind };
}

// ---------------------------------------------------------------- env / one-shot app-server
/** process.env overlaid with a caller-supplied {NAME: 'value'} object (non-string values are ignored). */
function mergeEnv(extra) {
  const env = { ...process.env };
  if (extra && typeof extra === 'object') for (const [k, v] of Object.entries(extra)) if (typeof k === 'string' && k && typeof v === 'string') env[k] = v;
  return env;
}
/** Spawn a short-lived `codex app-server`, handshake, run `work(rpc)`, always kill it. Never throws; resolves work's value or `fallback`. */
async function withServer(custom, env, timeoutMs, fallback, work) {
  let proc = null, timer = null;
  try {
    const r = resolveCodex(custom);
    if (!r) return fallback;
    proc = spawnCodex(r, ['--no-daemon', 'app-server'], { cwd: os.homedir(), env: mergeEnv(env) });
    proc.on('error', () => { });
    const rpc = new Rpc(proc, null, (j) => rpc.respondError(j.id, -32601, 'unsupported'), null);
    const guarded = (async () => { const init = await rpc.handshake(); if (init.error) return fallback; return work(rpc); })();
    return await Promise.race([guarded, new Promise((res) => { timer = setTimeout(() => res(fallback), timeoutMs); })]);
  } catch { return fallback; }
  finally { clearTimeout(timer); killTree(proc); }
}

// ---------------------------------------------------------------- one-shot service info
async function service(custom, env) {
  const out = { installed: false, exe: null, version: null, account: { type: null, planType: null, loggedIn: false }, usage: null, models: [] };
  try {
    const r = resolveCodex(custom);
    if (!r) return out;
    out.installed = true; out.exe = r.exe;
    try { // version straight from the CLI (cheap, independent of the app-server)
      const v = spawnSync(r.exe, ['--version'], { encoding: 'utf8', windowsHide: true, shell: !!r.viaShell, timeout: 8000, env: mergeEnv(env) });
      const m = /(\d+\.\d+\.\d+[\w.\-]*)/.exec(v.stdout || ''); if (m) out.version = m[1];
    } catch { /* ignore */ }
    await withServer(custom, env, 20000, null, async (rpc) => {
      const listModels = async () => { // follow pagination; includeHidden also returns legacy/hidden picker entries
        const data = []; let cursor = null;
        for (let i = 0; i < 10; i++) {
          const ml = await rpc.req('model/list', { includeHidden: true, limit: 200, ...(cursor ? { cursor } : {}) });
          if (!ml.result || !Array.isArray(ml.result.data)) break;
          data.push(...ml.result.data); cursor = ml.result.nextCursor; if (!cursor) break;
        }
        return data;
      };
      const [acc, rl, mdata] = await Promise.all([rpc.req('account/read', { refreshToken: false }), rpc.req('account/rateLimits/read', null), listModels()]);
      const a = acc.result && acc.result.account; // email deliberately dropped
      if (a) out.account = { type: a.type, planType: a.planType || null, loggedIn: true };
      if (rl.result) out.usage = usageFrom(rl.result.rateLimits);
      out.models = mdata.map((m) => ({
        id: m.id || m.model, label: m.displayName || m.model, description: m.description || '', hidden: !!m.hidden,
        efforts: (m.supportedReasoningEfforts || []).map((e) => ({ id: e.reasoningEffort, description: e.description || '' })),
        defaultEffort: m.defaultReasoningEffort || null, inputModalities: m.inputModalities || ['text', 'image'], isDefault: !!m.isDefault,
      }));
      return true;
    });
  } catch { /* partial results are fine */ }
  return out;
}

// ---------------------------------------------------------------- session history (listSessions / readSession)
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'unknown'];
const toMs = (t) => { if (t == null) return 0; const n = Number(t); if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n; const d = Date.parse(t); return Number.isFinite(d) ? d : 0; };
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
/** Strip Codex's injected context wrappers (<environment_context>, AGENTS.md instructions, ...) from a user message. */
const realUserText = (t) => {
  t = String(t || '').trim();
  if (/^<(environment_context|user_instructions|user_action|turn_aborted|permissions)\b/i.test(t) || /^# AGENTS\.md instructions/i.test(t)) return '';
  return t;
};
/** UserInput[] -> Claude content blocks (text + base64 images where inline). */
function userBlocks(content) {
  const out = [];
  for (const c of content || []) {
    if (!c) continue;
    if (c.type === 'text') { const t = realUserText(c.text); if (t) out.push({ type: 'text', text: t }); }
    else if (c.type === 'image' && typeof c.url === 'string') {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(c.url);
      if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      else out.push({ type: 'text', text: '[image]' });
    } else if (c.type === 'localImage') {
      let done = false; // inline the picture when the file still exists (temp copies are deleted on kill)
      try {
        if (c.path && fs.statSync(c.path).size < 6 * 1024 * 1024) {
          const ext = path.extname(c.path).slice(1).toLowerCase();
          out.push({ type: 'image', source: { type: 'base64', media_type: 'image/' + (ext === 'jpg' ? 'jpeg' : ext || 'png'), data: fs.readFileSync(c.path).toString('base64') } }); done = true;
        }
      } catch { /* file gone */ }
      if (!done) out.push({ type: 'text', text: '[image attachment no longer available]' });
    }
    else if (c.type === 'skill' || c.type === 'mention') out.push({ type: 'text', text: '[' + c.type + ': ' + (c.name || c.path || '') + ']' });
  }
  return out;
}

async function listSessions(custom, opts) {
  opts = opts || {};
  const max = Math.min(opts.limit || 200, 500);
  try {
    const rows = await withServer(custom, opts.env, 15000, null, async (rpc) => {
      const acc = []; let cursor = null;
      for (let i = 0; i < 10 && acc.length < max; i++) {
        const r = await rpc.req('thread/list', { limit: 100, sortKey: 'updated_at', archived: false, sourceKinds: SOURCE_KINDS, ...(cursor ? { cursor } : {}) });
        if (r.error || !r.result || !Array.isArray(r.result.data)) { if (!acc.length) return null; break; }
        acc.push(...r.result.data); cursor = r.result.nextCursor; if (!cursor) break;
      }
      return acc;
    });
    if (rows) {
      return rows.slice(0, max).map((t) => ({
        id: t.id, title: clip(t.name || t.preview, 120) || '(untitled)', cwd: t.cwd || null,
        updatedAt: toMs(t.updatedAt), createdAt: toMs(t.createdAt) || undefined, provider: 'codex',
      })).sort((a, b) => b.updatedAt - a.updatedAt);
    }
  } catch { /* fall through to the filesystem scan */ }
  try { return scanRollouts(opts.env, max); } catch { return []; }
}

/** Fallback when the app-server can't list: parse the first lines of ~/.codex/sessions/**\/rollout-*.jsonl */
function scanRollouts(env, max) {
  const home = (env && env.CODEX_HOME) || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const files = [];
  const walk = (d, depth) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory() && depth < 5) walk(f, depth + 1);
      else if (e.isFile() && /^rollout-.*\.jsonl$/i.test(e.name)) { try { files.push({ f, m: fs.statSync(f).mtimeMs }); } catch { /* gone */ } }
    }
  };
  walk(path.join(home, 'sessions'), 0);
  files.sort((a, b) => b.m - a.m);
  const out = [];
  for (const { f, m } of files.slice(0, max)) {
    try {
      const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(256 * 1024); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      let id = null, cwd = null, created = 0, title = '';
      for (const line of buf.toString('utf8', 0, n).split('\n')) {
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.type === 'session_meta' && j.payload) { id = j.payload.id; cwd = j.payload.cwd; created = toMs(j.payload.timestamp || j.timestamp); }
        else if (j.type === 'event_msg' && j.payload && j.payload.type === 'user_message' && !title) { title = clip(realUserText(j.payload.message), 120); }
        if (id && title) break;
      }
      if (id) out.push({ id, title: title || '(untitled)', cwd, updatedAt: m, createdAt: created || undefined, provider: 'codex' });
    } catch { /* skip */ }
  }
  return out;
}

/** thread items -> Claude-history events (same mapping as the live adapter). */
function itemsToEvents(items, evs, turnKey) {
  const asst = (id, content) => evs.push({ type: 'assistant', message: { id, role: 'assistant', content } });
  const result = (id, content, bad) => evs.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: !!bad }] } });
  for (const item of items || []) {
    if (!item) continue;
    const id = item.id || ('it-' + evs.length), mid = 'cx-' + id;
    switch (item.type) {
      case 'userMessage': { const c = userBlocks(item.content); if (c.length) evs.push({ type: 'user', message: { role: 'user', content: c } }); break; }
      case 'agentMessage': if (item.text) asst(mid, [{ type: 'text', text: item.text }]); break;
      case 'plan': if (item.text) asst(mid, [{ type: 'text', text: item.text }]); break;
      case 'reasoning': {
        const body = (item.summary && item.summary.length ? item.summary : item.content || []).join('\n\n');
        if (body.trim()) asst(mid, [{ type: 'thinking', thinking: body }]); break;
      }
      case 'commandExecution': {
        asst(mid, [{ type: 'tool_use', id, name: 'Bash', input: { command: item.command, cwd: item.cwd } }]);
        const out = item.aggregatedOutput == null ? '' : item.aggregatedOutput;
        const bad = item.status === 'failed' || item.status === 'declined' || (item.exitCode != null && item.exitCode !== 0);
        const note = item.status === 'declined' ? 'Command was declined.' : item.exitCode ? `exit code ${item.exitCode}` : '';
        result(id, [out, note].filter(Boolean).join('\n') || '(no output)', bad); break;
      }
      case 'fileChange': {
        const t = fileChangeTool(item.changes);
        asst(mid, [{ type: 'tool_use', id, name: t.name, input: t.input }]);
        const bad = item.status === 'failed' || item.status === 'declined';
        result(id, bad ? `Patch ${item.status}.` : (item.changes || []).map((c) => `${(c.kind && c.kind.type) || 'update'} ${c.path}`).join('\n') || 'Applied.', bad); break;
      }
      case 'mcpToolCall': {
        const name = `mcp__${item.server}__${item.tool}`;
        asst(mid, [{ type: 'tool_use', id, name, input: item.arguments && typeof item.arguments === 'object' ? item.arguments : { arguments: item.arguments } }]);
        const err = item.error && item.error.message;
        const res = item.result ? textOf(item.result.content) || (item.result.structuredContent ? JSON.stringify(item.result.structuredContent) : '') : '';
        result(id, err || res || '(no output)', !!err || item.status === 'failed'); break;
      }
      case 'webSearch': asst(mid, [{ type: 'tool_use', id, name: 'WebSearch', input: { query: item.query || '' } }]); result(id, 'Search completed.', false); break;
      case 'dynamicToolCall': {
        asst(mid, [{ type: 'tool_use', id, name: item.tool, input: item.arguments && typeof item.arguments === 'object' ? item.arguments : {} }]);
        result(id, textOf((item.contentItems || []).map((c) => ({ type: 'text', text: c.text }))) || '(no output)', item.success === false); break;
      }
      default: break;
    }
  }
}

async function readSession(custom, id, opts) {
  opts = opts || {};
  const cap = opts.limit || 400;
  try {
    const turns = await withServer(custom, opts.env, 15000, null, async (rpc) => {
      const r = await rpc.req('thread/read', { threadId: id, includeTurns: true });
      if (r.result && r.result.thread && Array.isArray(r.result.thread.turns) && r.result.thread.turns.length) return r.result.thread.turns;
      // paginated fallback: turns/list newest first, with full items
      const all = []; let cursor = null;
      for (let i = 0; i < 40; i++) {
        const t = await rpc.req('thread/turns/list', { threadId: id, itemsView: 'full', sortDirection: 'desc', limit: 50, ...(cursor ? { cursor } : {}) });
        if (t.error || !t.result || !Array.isArray(t.result.data)) break;
        all.push(...t.result.data); cursor = t.result.nextCursor; if (!cursor) break;
      }
      return all.length ? all.reverse() : (r.result && r.result.thread && r.result.thread.turns) || null;
    });
    if (turns) {
      const evs = [];
      for (const t of turns) itemsToEvents(t.items, evs, t.id);
      return evs.slice(-cap);
    }
  } catch { /* fall through */ }
  try { return readRollout(opts.env, id).slice(-cap); } catch { return []; }
}

/** Fallback: rebuild events from the raw rollout file (response_item records). */
function readRollout(env, id) {
  const home = (env && env.CODEX_HOME) || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  let file = null;
  const walk = (d, depth) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (file) return;
      const f = path.join(d, e.name);
      if (e.isDirectory() && depth < 5) walk(f, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.includes(id)) file = f;
    }
  };
  walk(path.join(home, 'sessions'), 0);
  if (!file) return [];
  const evs = [], calls = new Map();
  let n = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.type !== 'response_item' || !j.payload) continue;
    const p = j.payload, mid = 'cxr-' + (++n);
    if (p.type === 'message') {
      const text = (p.content || []).map((c) => c.text || '').join('\n');
      if (p.role === 'user') { const t = realUserText(text); if (t) evs.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: t }] } }); }
      else if (p.role === 'assistant' && text) evs.push({ type: 'assistant', message: { id: mid, role: 'assistant', content: [{ type: 'text', text }] } });
    } else if (p.type === 'reasoning') {
      const body = (p.summary || []).map((s) => s.text || '').join('\n\n');
      if (body.trim()) evs.push({ type: 'assistant', message: { id: mid, role: 'assistant', content: [{ type: 'thinking', thinking: body }] } });
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      let args = {}; try { args = p.arguments ? JSON.parse(p.arguments) : p.action || (p.input ? { input: p.input } : {}); } catch { args = { arguments: p.arguments }; }
      const cid = p.call_id || mid;
      const isShell = /shell|exec_command/.test(p.name || '') || p.type === 'local_shell_call';
      const name = isShell ? 'Bash' : p.name === 'apply_patch' ? 'ApplyPatch' : p.name || 'tool';
      const input = isShell ? { command: Array.isArray(args.command) ? args.command.join(' ') : args.command || args.cmd || '', cwd: args.workdir } : p.name === 'apply_patch' ? { patch: args.input || p.input || '' } : args;
      calls.set(cid, 1);
      evs.push({ type: 'assistant', message: { id: mid, role: 'assistant', content: [{ type: 'tool_use', id: cid, name, input }] } });
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      if (!calls.has(p.call_id)) continue;
      let out = p.output; if (out && typeof out === 'object') out = out.content || JSON.stringify(out);
      evs.push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: p.call_id, content: String(out == null ? '' : out), is_error: false }] } });
    }
  }
  return evs;
}

// ---------------------------------------------------------------- undo / rewind
// What Codex gives us: `thread/revert {threadId, beforeTurnId}` drops that turn and every later one from the thread's
// durable AND in-memory model history. Verified live: the model then only knows the earlier turns. It does NOT touch the
// disk (the schema says so explicitly), so files are reverted here from the reverted turns' `fileChange` items
// (apply_patch edits). Files changed through shell commands are not reported by Codex and cannot be reverted safely.

const eolOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
/** Parse the hunks of a unified diff body -> [{newStart, oldL, newL}] (null when there is no hunk at all). */
function parseHunks(diff) {
  const hunks = []; let h = null;
  for (const l of String(diff).split(/\r?\n/)) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m) { h = { newStart: +m[1], oldL: [], newL: [] }; hunks.push(h); continue; }
    if (!h || l.startsWith('\\')) continue;
    if (l.startsWith('-')) h.oldL.push(l.slice(1));
    else if (l.startsWith('+')) h.newL.push(l.slice(1));
    else if (l.startsWith(' ')) { h.oldL.push(l.slice(1)); h.newL.push(l.slice(1)); }
  }
  return hunks.length ? hunks : null;
}
/** Undo a unified diff on `content`. Returns the old text, or null unless EVERY hunk's "after" text is found verbatim
 *  (so a file the user edited since is left alone instead of being corrupted). Pure function, exported for tests. */
function reversePatch(content, diff) {
  const hunks = parseHunks(diff); if (!hunks) return null;
  const eol = eolOf(content), endsNl = /\n$/.test(content);
  const lines = content.split(/\r?\n/); if (endsNl) lines.pop();
  let delta = 0;
  for (const h of hunks) {
    const want = h.newStart - 1 + delta, n = h.newL.length;
    const at = (i) => { for (let k = 0; k < n; k++) if (lines[i + k] !== h.newL[k]) return false; return i >= 0 && i + n <= lines.length; };
    let pos = -1;
    if (n === 0) { if (want >= 0 && want <= lines.length) pos = want; } // pure deletion hunk: no text to anchor, trust the header
    else if (at(want)) pos = want;
    else { let best = Infinity; for (let i = 0; i + n <= lines.length; i++) if (at(i) && Math.abs(i - want) < best) { best = Math.abs(i - want); pos = i; } }
    if (pos < 0) return null;
    lines.splice(pos, n, ...h.oldL); delta += h.oldL.length - n;
  }
  return lines.join(eol) + (endsNl && lines.length ? eol : '');
}
const normNl = (s) => String(s).replace(/\r\n/g, '\n').replace(/\n$/, '');
const looksLikeDiff = (d) => /^(@@|---|\+\+\+)/m.test(d);
const rd = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

/** Reverse the applied fileChange items of `turns` (newest first). -> {reverted, skipped, details[]} */
function revertFiles(turns, cwd) {
  const out = { reverted: 0, skipped: 0, details: [] };
  const abs = (p) => path.resolve(cwd, String(p));
  const skip = (p, why) => { out.skipped++; out.details.push(`skipped ${p}: ${why}`); };
  for (let t = turns.length - 1; t >= 0; t--) {
    const its = turns[t].items || [];
    for (let i = its.length - 1; i >= 0; i--) {
      const it = its[i];
      if (!it || it.type !== 'fileChange' || it.status !== 'completed') continue; // failed/declined patches changed nothing
      const chs = it.changes || [];
      for (let c = chs.length - 1; c >= 0; c--) {
        const ch = chs[c], kind = (ch.kind && ch.kind.type) || 'update', file = abs(ch.path), diff = ch.diff || '';
        try {
          const cur = rd(file);
          if (kind === 'add') {
            const written = looksLikeDiff(diff) ? diffToOldNew(diff).new_string : diff;
            if (cur == null) skip(ch.path, 'already gone');
            else if (normNl(cur) !== normNl(written)) skip(ch.path, 'modified since the agent created it');
            else { fs.unlinkSync(file); out.reverted++; } // content is byte-for-byte what the agent wrote -> provably its file
          } else if (kind === 'delete') {
            if (cur != null) skip(ch.path, 'exists again');
            else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, looksLikeDiff(diff) ? diffToOldNew(diff).old_string : diff); out.reverted++; }
          } else { // update, optionally with a rename (move_path = new location)
            const mv = ch.kind && ch.kind.move_path ? abs(ch.kind.move_path) : null;
            const src = mv || file, txt = mv ? rd(mv) : cur;
            if (txt == null) { skip(ch.path, 'file not found'); continue; }
            if (mv && cur != null) { skip(ch.path, 'original path exists again'); continue; }
            const back = diff.trim() ? reversePatch(txt, diff) : txt;
            if (back == null) { skip(ch.path, 'modified since (patch no longer applies)'); continue; }
            fs.writeFileSync(file, back);
            if (mv && src !== file) fs.unlinkSync(src);
            out.reverted++;
          }
        } catch (e) { skip(ch.path, e.message); }
      }
    }
  }
  return out;
}

/** All turns of a thread, oldest first, with full items. */
async function listAllTurns(rpc, threadId) {
  const all = []; let cursor = null;
  for (let i = 0; i < 100; i++) {
    const r = await rpc.req('thread/turns/list', { threadId, itemsView: 'full', sortDirection: 'asc', limit: 50, ...(cursor ? { cursor } : {}) });
    if (r.error || !r.result || !Array.isArray(r.result.data)) { if (!i) return { error: (r.error && r.error.message) || 'turns/list failed' }; break; }
    all.push(...r.result.data); cursor = r.result.nextCursor; if (!cursor) break;
  }
  return { turns: all };
}
/** Core of rewind for both live and one-shot use. `rpc` must have `threadId` loaded. */
async function rewindThread(rpc, threadId, keepTurns, cwd) {
  keepTurns = Math.floor(Number(keepTurns));
  if (!Number.isFinite(keepTurns) || keepTurns < 0) return { ok: false, error: 'keepTurns must be a number >= 0' };
  const l = await listAllTurns(rpc, threadId);
  if (l.error) return { ok: false, error: l.error };
  // A "user turn" as the renderer counts it = one userMessage with real text/images. Steering can put several into one
  // Codex turn; Codex can only cut at turn boundaries, so a cut inside such a turn removes the whole turn.
  let seen = 0, cut = -1, kept = 0, partial = false;
  l.turns.forEach((t, ti) => {
    if (cut >= 0) return;
    const n = (t.items || []).filter((x) => x && x.type === 'userMessage' && userBlocks(x.content).length).length;
    if (seen + n > keepTurns) { cut = ti; kept = seen; partial = seen < keepTurns; } else seen += n;
  });
  if (cut < 0) return { ok: true, filesReverted: 0, filesSkipped: 0, note: 'Nothing to undo' };
  const doomed = l.turns.slice(cut);
  const r = await rpc.req('thread/revert', { threadId, beforeTurnId: l.turns[cut].id });
  if (r.error) return { ok: false, error: 'thread/revert failed: ' + r.error.message };
  const f = revertFiles(doomed, cwd || os.homedir());
  const shell = doomed.reduce((n, t) => n + (t.items || []).filter((x) => x && x.type === 'commandExecution').length, 0);
  const notes = [];
  if (partial) notes.push(`Codex can only undo whole turns; kept ${kept} user message(s) instead of ${keepTurns}.`);
  if (shell) notes.push(`${shell} shell command(s) ran in the undone turns; Codex does not report what they changed, so those effects were not reverted.`);
  notes.push(...f.details);
  return { ok: true, filesReverted: f.reverted, filesSkipped: f.skipped, ...(notes.length ? { note: notes.join(' ') } : {}) };
}
/** Rewind a thread that is not live (e.g. just opened from history). Same result shape as adapter.rewind().
 *  opts: {env, cwd}. cwd resolves relative file paths and defaults to the thread's own cwd. */
async function rewindSession(custom, sessionId, keepTurns, opts) {
  opts = opts || {};
  if (!sessionId) return { ok: false, error: 'No session id' };
  const res = await withServer(custom, opts.env, 90000, null, async (rpc) => {
    const r = await rpc.req('thread/resume', { threadId: sessionId, excludeTurns: true });
    if (r.error || !r.result) return { ok: false, error: 'Could not load thread: ' + ((r.error && r.error.message) || 'no result') };
    return rewindThread(rpc, sessionId, keepTurns, opts.cwd || (r.result.thread && r.result.thread.cwd) || (r.result.cwd));
  });
  return res || { ok: false, error: 'Codex CLI not available or timed out' };
}

// ---------------------------------------------------------------- login / logout
function runCli(custom, args, timeoutMs, env, input) {
  return new Promise((resolve) => {
    const r = resolveCodex(custom);
    if (!r) return resolve({ ok: false, out: 'Codex CLI not found' });
    let out = '', p;
    try { p = spawnCodex(r, args, { cwd: os.homedir(), env: mergeEnv(env) }); } catch (e) { return resolve({ ok: false, out: e.message }); }
    if (p.stdin) { p.stdin.on('error', () => { }); try { p.stdin.end(input == null ? undefined : input); } catch { /* ignore */ } }
    const t = setTimeout(() => { killTree(p); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => { clearTimeout(t); resolve({ ok: false, out: e.message }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, out: out.trim() }); });
  });
}
const login = (custom, env) => runCli(custom, ['login'], 10 * 60 * 1000, env); // opens the browser; waits for completion
const logout = (custom, env) => runCli(custom, ['logout'], 30000, env);
/** Non-interactive API-key login: `codex login --with-api-key` reads the key from stdin and stores it in ~/.codex/auth.json
 *  (REPLACES a ChatGPT login). `env` may carry CODEX_HOME to target a different home. */
const loginWithApiKey = (custom, key, env) => {
  key = String(key || '').trim();
  if (!key) return Promise.resolve({ ok: false, out: 'Empty API key' });
  return runCli(custom, ['login', '--with-api-key'], 30000, env, key + '\n');
};

module.exports = { start, service, resolveCodex, login, logout, loginWithApiKey, listSessions, readSession, rewindSession, _fallback: { scanRollouts, readRollout }, _internals: { reversePatch, revertFiles } };
