'use strict';
// Local (offline after first download) Whisper speech-to-text, main-process side.
// Heavy work happens in worker.js (worker_threads); this module is a queue + lifecycle manager.
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MODELS = {
  tiny:  { repo: 'Xenova/whisper-tiny',  dtype: 'q8', sizeMB: 42,  quality: 'poor for non-English',
           files: ['encoder_model_quantized.onnx', 'decoder_model_merged_quantized.onnx'] },
  base:  { repo: 'Xenova/whisper-base',  dtype: 'q8', sizeMB: 76,  quality: 'fair; weak on Romanian/Hungarian',
           files: ['encoder_model_quantized.onnx', 'decoder_model_merged_quantized.onnx'] },
  small: { repo: 'Xenova/whisper-small', dtype: 'q8', sizeMB: 240, quality: 'good; recommended default for non-English',
           files: ['encoder_model_quantized.onnx', 'decoder_model_merged_quantized.onnx'] },
  'large-turbo': { repo: 'onnx-community/whisper-large-v3-turbo', dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' }, sizeMB: 730,
           quality: 'best; slow on CPU', files: ['encoder_model_q4.onnx', 'decoder_model_merged_q4.onnx'] },
};
const DEFAULT_MODEL = 'small';const IDLE_MS = 10 * 60 * 1000;

let modelDir = null;
let worker = null;
let loadedModel = null;
let busy = false;
let idleTimer = null;
let nextId = 1;
const queue = [];
let current = null; // {id, resolve, reject, onProgress}

function getModelDir() { return modelDir || path.join(os.homedir(), '.reva-models'); }
function setModelDir(dir) {
  if (dir && dir !== modelDir) {
    modelDir = dir;
    killWorker(); // cacheDir is applied per job, but drop cached pipeline to be safe
  }
}

function workerPath() {
  let p = path.join(__dirname, 'worker.js');
  // Packaged: worker threads cannot reliably execute from inside app.asar -> use asarUnpack'd copy if present.
  if (p.includes('app.asar' + path.sep)) {
    const un = p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    if (fs.existsSync(un)) p = un;
  }
  return p;
}

function packageAvailable() {
  try { require.resolve('@huggingface/transformers'); return true; } catch (_) { return false; }
}

function killWorker() {
  clearTimeout(idleTimer); idleTimer = null;
  const w = worker;
  worker = null; loadedModel = null;
  if (w) { try { w.removeAllListeners(); w.on('error', () => {}); w.terminate(); } catch (_) {} }
}
function armIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!busy && !queue.length) killWorker(); }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

function failCurrent(err) {
  const c = current; current = null; busy = false;
  if (c) c.reject(err instanceof Error ? err : new Error(String(err)));
}

function ensureWorker() {
  if (worker) return worker;
  const w = new Worker(workerPath());
  worker = w;
  w.on('message', (m) => {
    if (!m || !current || m.id !== current.id) return;
    if (m.type === 'progress') {
      if (m.phase === 'load' && m.pct >= 100) loadedModel = current.model;
      try { current.onProgress && current.onProgress({ phase: m.phase, pct: m.pct, file: m.file }); } catch (_) {}
    } else if (m.type === 'result') {
      loadedModel = current.model;
      const c = current; current = null; busy = false;
      if (c.kind === 'ensure') c.resolve({ ok: true });
      else c.resolve({ text: m.text, language: m.language, languageName: m.languageName, confidence: m.confidence, candidates: m.candidates, segments: m.segments, durationSec: m.durationSec });
      pump();
    } else if (m.type === 'error') {
      const msg = m.offline && current.needsDownload
        ? 'Could not download the Whisper model (offline?)'
        : 'Whisper failed: ' + m.message;
      failCurrent(new Error(msg));
      pump();
    }
  });
  w.on('error', (e) => {
    if (worker === w) { worker = null; loadedModel = null; }
    failCurrent(new Error('Whisper worker crashed: ' + (e && e.message || e)));
    pump();
  });
  w.on('exit', () => {
    if (worker === w) { worker = null; loadedModel = null; }
    if (current) { failCurrent(new Error('Whisper worker exited unexpectedly')); pump(); }
  });
  return w;
}

function pump() {
  if (busy) return;
  const job = queue.shift();
  if (!job) { armIdle(); return; }
  clearTimeout(idleTimer);
  busy = true;
  current = job;
  job.needsDownload = !isDownloaded(job.model);
  try {
    const w = ensureWorker();
    const base = { id: job.id, spec: { key: job.model, repo: MODELS[job.model].repo, dtype: MODELS[job.model].dtype }, cacheDir: getModelDir() };
    if (job.kind === 'ensure') w.postMessage({ ...base, type: 'ensure' });
    else w.postMessage({ ...base, type: 'run', audio: job.audio, language: job.language, task: job.task, prompt: job.prompt }, [job.audio]);
  } catch (e) {
    failCurrent(e); pump();
  }
}

function isDownloaded(size) {
  const m = MODELS[size];
  if (!m) return false;
  const dir = path.join(getModelDir(), ...m.repo.split('/'), 'onnx');
  return m.files.every((f) => { try { return fs.statSync(path.join(dir, f)).size > 0; } catch (_) { return false; } });
}

// Accepts Float32Array | Buffer | Uint8Array | ArrayBuffer | other typed array of bytes; returns a fresh
// standalone ArrayBuffer of float32 samples (copy => safe alignment, and transferable without detaching caller data).
function toTransferable(audio) {
  let bytes;
  if (audio instanceof Float32Array) {
    const copy = new Float32Array(audio.length); copy.set(audio); return copy.buffer;
  }
  if (audio instanceof ArrayBuffer) bytes = new Uint8Array(audio);
  else if (ArrayBuffer.isView(audio)) bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
  else if (audio && audio.buffer instanceof ArrayBuffer && typeof audio.byteLength === 'number') bytes = new Uint8Array(audio.buffer, audio.byteOffset || 0, audio.byteLength);
  else if (Array.isArray(audio)) return Float32Array.from(audio).buffer;
  else throw new Error('Unsupported audio data type');
  if (bytes.byteLength % 4 !== 0) throw new Error('Audio byte length is not a multiple of 4 (expected Float32 PCM)');
  const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
  return copy.buffer;
}

function checkSize(size) {
  if (!MODELS[size]) throw new Error('Unknown Whisper model "' + size + '" (use ' + Object.keys(MODELS).join(', ') + ')');
}

function enqueue(job) {
  return new Promise((resolve, reject) => {
    job.id = nextId++; job.resolve = resolve; job.reject = reject;
    queue.push(job);
    pump();
  });
}

function transcribe(audio, opts = {}) {
  try {
    if (!packageAvailable()) return Promise.reject(new Error('Speech recognition is unavailable: @huggingface/transformers is not installed'));
    const model = opts.model || DEFAULT_MODEL;
    checkSize(model);
    const buf = toTransferable(audio);
    if (buf.byteLength < 4 * 1600) return Promise.reject(new Error('Audio is too short to transcribe'));
    return enqueue({
      kind: 'run', model, audio: buf,
      language: opts.language || 'auto',
      task: opts.task === 'translate' ? 'translate' : 'transcribe',
      prompt: opts.prompt || opts.initialPrompt || '',
      onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : null,
    });
  } catch (e) { return Promise.reject(e); }
}

function ensureModel(size = DEFAULT_MODEL, onProgress) {
  try {
    if (!packageAvailable()) return Promise.reject(new Error('Speech recognition is unavailable: @huggingface/transformers is not installed'));
    checkSize(size);
    return enqueue({ kind: 'ensure', model: size, onProgress: typeof onProgress === 'function' ? onProgress : null });
  } catch (e) { return Promise.reject(e); }
}

function status() {
  const downloaded = {};
  for (const k of Object.keys(MODELS)) downloaded[k] = isDownloaded(k);
  return {
    available: packageAvailable(),
    downloaded,
    loadedModel: loadedModel,
    busy,
  };
}

module.exports = { transcribe, status, ensureModel, setModelDir, MODELS, DEFAULT_MODEL };

