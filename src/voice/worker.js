'use strict';
// Whisper worker thread. Protocol (parent -> worker):
//   {id, type:'run',    spec:{key,repo,dtype}, audio:ArrayBuffer(Float32 16k mono), language, task, prompt, cacheDir}
//   {id, type:'ensure', spec, cacheDir}
// worker -> parent: {id, type:'progress', phase, pct, file?} | {id, type:'result', ...} | {id, type:'error', message, offline?}
const { parentPort } = require('worker_threads');

const SR = 16000;
const WIN = 30 * SR;

let tf = null;
let pipe = null;
let pipeKey = null; // cached per model (repo+dtype) -- never per language
let currentId = null;
let lastPct = {};

async function getTf(cacheDir) {
  if (!tf) tf = await import('@huggingface/transformers');
  tf.env.cacheDir = cacheDir;
  tf.env.allowLocalModels = true;
  tf.env.allowRemoteModels = true;
  return tf;
}

function send(msg) { try { parentPort.postMessage(msg); } catch (_) {} }

function progressCb(p) {
  if (currentId == null || !p) return;
  if (p.status === 'progress') {
    const file = p.file || p.name;
    const pct = Math.max(0, Math.min(100, Math.round(p.progress || 0)));
    if (lastPct[file] === pct) return;
    lastPct[file] = pct;
    send({ id: currentId, type: 'progress', phase: 'download', pct, file });
  }
}

async function loadPipeline(spec, cacheDir) {
  const t = await getTf(cacheDir);
  const key = spec.repo + '|' + JSON.stringify(spec.dtype);
  if (pipe && pipeKey === key) return pipe;
  if (pipe) { try { await pipe.dispose(); } catch (_) {} pipe = null; pipeKey = null; }
  lastPct = {};
  send({ id: currentId, type: 'progress', phase: 'load', pct: 0 });
  pipe = await t.pipeline('automatic-speech-recognition', spec.repo, {
    dtype: spec.dtype, device: 'cpu', progress_callback: progressCb,
  });
  pipeKey = key;
  send({ id: currentId, type: 'progress', phase: 'load', pct: 100 });
  return pipe;
}

function langName(code) {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch (_) { return code; }
}

// Most energetic 30 s window (so a silent/music intro doesn't decide the language).
function loudestWindow(audio) {
  if (audio.length <= WIN) return audio;
  const hop = 2 * SR, nb = Math.ceil(audio.length / hop), e = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let s = 0; const a = b * hop, z = Math.min(audio.length, a + hop);
    for (let i = a; i < z; i += 4) s += audio[i] * audio[i];
    e[b] = s / Math.max(1, (z - a) / 4);
  }
  const nbw = Math.round(WIN / hop);
  let best = 0, bestV = -1, cur = 0;
  for (let b = 0; b < nb; b++) {
    cur += e[b]; if (b >= nbw) cur -= e[b - nbw];
    if (b >= nbw - 1 && cur > bestV) { bestV = cur; best = b - nbw + 1; }
  }
  const a = Math.max(0, best * hop);
  return audio.subarray(a, Math.min(audio.length, a + WIN));
}

// Softmax over the 99 language tokens after <|startoftranscript|>. Returns [{code, p}] sorted desc, or null.
async function detectLanguages(p, audio, t) {
  try {
    const inputs = await p.processor(loudestWindow(audio));
    const gc = p.model.generation_config;
    const ids = new t.Tensor('int64', BigInt64Array.from([BigInt(gc.decoder_start_token_id)]), [1, 1]);
    const out = await p.model({ ...inputs, decoder_input_ids: ids });
    const lg = out.logits.data;
    const ent = Object.entries(gc.lang_to_id).map(([k, id]) => [k.replace(/[<|>]/g, ''), lg[Number(id)]]);
    const mx = Math.max(...ent.map((x) => x[1]));
    const ex = ent.map(([c, v]) => [c, Math.exp(v - mx)]);
    const sum = ex.reduce((s, x) => s + x[1], 0);
    return ex.map(([code, v]) => ({ code, p: v / sum })).sort((a, b) => b.p - a.p);
  } catch (e) {
    return null;
  }
}

// Split into <=30 s pieces at the quietest spot near each boundary => no overlapping windows, no duplicated text.
function splitAudio(audio) {
  const pieces = [];
  let start = 0;
  while (audio.length - start > WIN) {
    const lo = start + 20 * SR, hi = start + WIN - Math.round(0.3 * SR);
    const frame = Math.round(0.2 * SR), step = Math.round(0.05 * SR);
    let bestPos = hi, bestE = Infinity;
    for (let pos = lo; pos <= hi; pos += step) {
      let s = 0; for (let i = pos; i < pos + frame; i += 2) s += audio[i] * audio[i];
      if (s < bestE) { bestE = s; bestPos = pos + (frame >> 1); }
    }
    pieces.push([start, bestPos]);
    start = bestPos;
  }
  pieces.push([start, audio.length]);
  return pieces;
}

// Whisper-hallucination guard: very repetitive output (same short phrase looping).
function repetitive(text) {
  const w = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (w.length < 12) return false;
  return new Set(w).size / w.length < 0.25;
}
// Looping garbage (e.g. one character repeated) that Whisper emits on noise/silence.
function junk(text) {
  return text.length > 30 && new Set(text.replace(/\s/g, '')).size / text.length < 0.06;
}
function score(text) {
  const w = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!w.length) return 0;
  return text.length * Math.min(1, (new Set(w).size / w.length) * 1.5);
}

async function runOne(p, piece, language, task, prompt) {
  const o = { return_timestamps: true, task, language };
  const out = await p(piece, o);
  return out;
}

function isOffline(e) {
  const m = String((e && (e.message || e)) || '') + ' ' + String((e && e.cause && (e.cause.code || e.cause.message)) || '');
  return /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network|Unauthorized|Could not locate|offline|Failed to fetch/i.test(m);
}

async function handle(m) {
  currentId = m.id;
  try {
    if (m.type === 'ensure') {
      await loadPipeline(m.spec, m.cacheDir);
      send({ id: m.id, type: 'result', ok: true });
      return;
    }
    const p = await loadPipeline(m.spec, m.cacheDir);
    const t = tf;
    const audio = new Float32Array(m.audio);
    const durationSec = audio.length / SR;
    const task = m.task === 'translate' ? 'translate' : 'transcribe';
    send({ id: m.id, type: 'progress', phase: 'transcribe', pct: 0 });

    let language, confidence = null, candidates = null, forced = false;
    if (m.language && m.language !== 'auto') {
      language = String(m.language).trim().toLowerCase(); forced = true; // code ('ro') or name ('romanian') both accepted
    } else {
      const det = await detectLanguages(p, audio, t);
      if (det) {
        language = det[0].code; confidence = det[0].p;
        candidates = det.slice(0, 3).map((d) => ({ code: d.code, name: langName(d.code), p: +d.p.toFixed(3) }));
      } else { language = 'en'; confidence = 0; }
    }

    const pieces = durationSec > 30 ? splitAudio(audio) : [[0, audio.length]];

    // Low-confidence auto-detect: try the two best candidates on the loudest window, keep the better text.
    if (!forced && candidates && confidence < 0.6 && candidates.length > 1) {
      const win = loudestWindow(audio);
      let bestScore = -1, bestCode = language;
      for (const c of candidates.slice(0, 2)) {
        const out = await runOne(p, win, c.code, task);
        const sc = repetitive(out.text || '') ? 0 : score(out.text || '') * (0.5 + c.p);
        if (sc > bestScore) { bestScore = sc; bestCode = c.code; }
      }
      language = bestCode;
    }

    const segments = [];
    for (let i = 0; i < pieces.length; i++) {
      const [a, b] = pieces[i];
      const off = a / SR;
      let out = await runOne(p, audio.subarray(a, b), language, task);
      for (const c of out.chunks || []) {
        const ts = c.timestamp || [0, null];
        const text = (c.text || '').trim();
        if (text && !junk(text)) segments.push({ start: +(off + (ts[0] ?? 0)).toFixed(2), end: +(off + (ts[1] ?? ts[0] ?? (b - a) / SR)).toFixed(2), text });
      }
      send({ id: m.id, type: 'progress', phase: 'transcribe', pct: Math.round(((i + 1) / pieces.length) * 100) });
    }
    send({
      id: m.id, type: 'result',
      text: segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim(),
      language: forced ? (language.length <= 3 ? language : language) : language,
      languageName: langName(language),
      confidence: forced ? 1 : confidence,
      candidates, segments, durationSec,
    });
  } catch (e) {
    send({ id: m.id, type: 'error', message: String((e && e.message) || e), offline: isOffline(e) });
  } finally {
    currentId = null;
  }
}

parentPort.on('message', (m) => { handle(m); });

process.on('uncaughtException', (e) => send({ id: currentId, type: 'error', message: String((e && e.message) || e) }));
process.on('unhandledRejection', (e) => send({ id: currentId, type: 'error', message: String((e && e.message) || e) }));

