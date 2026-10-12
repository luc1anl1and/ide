// Voice recording, audio/video attachments, local Whisper transcription (via main process)
(function () {
  const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'ogg', 'flac', 'opus', 'aac', 'weba']);
  const VIDEO_EXT = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v']);
  const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
  const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac', opus: 'audio/ogg', aac: 'audio/aac', weba: 'audio/webm', mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo', m4v: 'video/mp4' };

  const fmtDur = (s) => { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  async function decodeMono16k(arrayBuffer) {
    const ctx = new AudioContext();
    let buf;
    try { buf = await ctx.decodeAudioData(arrayBuffer.slice(0)); } finally { ctx.close(); }
    const len = Math.ceil(buf.duration * 16000);
    const off = new OfflineAudioContext(1, Math.max(1, len), 16000);
    const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
    const out = await off.startRendering();
    return { pcm: out.getChannelData(0), duration: buf.duration };
  }

  async function transcribePcm(pcm, att) {
    const v = A.settings.voice || {};
    const copy = new Float32Array(pcm); // detach from the audio buffer
    const off = api.on('voice:progress', (p) => {
      att.progress = p; att.onUpdate && att.onUpdate();
    });
    try {
      const r = await api.voice.transcribe({ audio: new Uint8Array(copy.buffer), model: v.model || 'base', language: v.language || 'auto' });
      if (!r.ok) throw new Error(r.error || 'Transcription failed');
      return r;
    } finally { off(); }
  }

  async function videoFrames(blobUrl, n) {
    const video = document.createElement('video'); video.muted = true; video.preload = 'auto'; video.src = blobUrl;
    await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = () => rej(new Error('Cannot decode video')); });
    if (!isFinite(video.duration)) { // MediaRecorder webm has no duration header: force the browser to find it
      await new Promise((res) => { video.ontimeupdate = () => { video.ontimeupdate = null; res(); }; video.currentTime = 1e101; });
      await new Promise((res) => { video.onseeked = res; video.currentTime = 0; });
    }
    const dur = video.duration || 0; if (!isFinite(dur) || dur <= 0) return { frames: [], duration: 0 };
    const k = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight, 1));
    const cv = document.createElement('canvas'); cv.width = Math.round(video.videoWidth * k) || 640; cv.height = Math.round(video.videoHeight * k) || 360;
    const ctx = cv.getContext('2d'); const frames = [];
    for (let i = 0; i < n; i++) {
      const t = Math.min(dur - 0.05, ((i + 0.5) / n) * dur);
      await new Promise((res) => { video.onseeked = res; video.currentTime = t; });
      ctx.drawImage(video, 0, 0, cv.width, cv.height);
      frames.push({ t, mediaType: 'image/jpeg', data: cv.toDataURL('image/jpeg', 0.8).split(',')[1], name: 'frame@' + fmtDur(t) });
    }
    return { frames, duration: dur };
  }

  function kindOf(name, type) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if ((type || '').startsWith('image/') || IMAGE_EXT.has(ext)) return 'image';
    if ((type || '').startsWith('audio/') || AUDIO_EXT.has(ext)) return 'audio';
    if ((type || '').startsWith('video/') || VIDEO_EXT.has(ext)) return 'video';
    return 'file';
  }

  const Media = {
    kindOf, fmtDur,
    // Create an attachment from a Blob/File and start processing; returns the attachment (with .promise)
    attach(blobOrBytes, name, opts = {}) {
      const ext = (name.split('.').pop() || '').toLowerCase();
      const type = blobOrBytes.type || MIME[ext] || '';
      const kind = opts.voice ? 'voice' : kindOf(name, type);
      const blob = blobOrBytes instanceof Blob ? blobOrBytes : new Blob([blobOrBytes], { type });
      const att = { id: uuid(), kind, name, size: blob.size, blob, url: URL.createObjectURL(blob), status: 'working', stage: 'Decoding…', transcript: '', frames: [], duration: 0, progress: null };
      att.promise = (async () => {
        try {
          const ab = await blob.arrayBuffer();
          if (kind === 'video') {
            att.stage = 'Reading video…'; att.onUpdate && att.onUpdate();
            const f = await videoFrames(att.url, +(A.settings.voice && A.settings.voice.frames) || 8);
            att.frames = f.frames; att.duration = f.duration;
          }
          att.stage = 'Decoding audio…'; att.onUpdate && att.onUpdate();
          let dec = null;
          try { dec = await decodeMono16k(ab); } catch (e) { if (kind === 'video') { dec = null; } else throw e; }
          if (dec) {
            att.duration = att.duration || dec.duration;
            if (dec.duration < 0.3) { att.transcript = ''; }
            else { att.stage = 'Transcribing…'; att.onUpdate && att.onUpdate(); const r = await transcribePcm(dec.pcm, att); att.transcript = (r.text || '').trim(); att.language = r.language; }
          }
          att.status = 'ready'; att.stage = '';
        } catch (e) { att.status = 'error'; att.error = e.message || String(e); att.stage = ''; }
        att.onUpdate && att.onUpdate(); return att;
      })();
      return att;
    },
    async attachPath(p) {
      const f = await api.fs.readBytes(p);
      return Media.attach(new Blob([f.data]), f.name);
    },
    // microphone recorder
    async devices() {
      try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); } catch { /* permission denied: labels may be blank */ }
      const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
      return list.map((d) => ({ id: d.deviceId, label: d.deviceId === 'default' ? (d.label || 'System default') : d.label || 'Microphone' }));
    },
    // live input level meter for the settings "test microphone" button
    async meter(deviceId, onLevel, ms = 6000) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : true });
      const ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 512; ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize); let stop = false;
      const tick = () => { if (stop) return; an.getByteTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v - 128)); onLevel(Math.min(1, m / 90)); requestAnimationFrame(tick); };
      tick(); setTimeout(end, ms);
      function end() { if (stop) return; stop = true; stream.getTracks().forEach((t) => t.stop()); ctx.close(); onLevel(0); }
      return end;
    },
    async record() {
      const dev = A.settings.voice && A.settings.voice.deviceId;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(dev && dev !== 'default' ? { deviceId: { exact: dev } } : {}), echoCancellation: true, noiseSuppression: true } });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); const chunks = []; const t0 = Date.now();
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.start(250);
      return {
        elapsed: () => (Date.now() - t0) / 1000,
        stop: () => new Promise((res) => { rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); res(new Blob(chunks, { type: rec.mimeType || 'audio/webm' })); }; rec.stop(); }),
        cancel: () => { rec.onstop = null; try { rec.stop(); } catch { } stream.getTracks().forEach((t) => t.stop()); },
      };
    },
    // text appended to the prompt for non-image attachments
    promptBlocks(atts) {
      const out = [];
      for (const a of atts) {
        if (a.kind === 'voice' && a.inserted) continue;
        if (a.kind === 'voice') out.push(`[Voice message transcript]\n${a.transcript || '(no speech detected)'}`);
        else if (a.kind === 'audio') out.push(`[Audio file "${a.name}" (${fmtDur(a.duration)}) transcript]\n${a.transcript || '(no speech detected)'}`);
        else if (a.kind === 'video') out.push(`[Video "${a.name}" (${fmtDur(a.duration)}): ${a.frames.length} evenly spaced frames are attached as images (${a.frames.map((f) => fmtDur(f.t)).join(', ')})${a.transcript ? '; audio transcript follows' : ''}]${a.transcript ? '\n' + a.transcript : ''}`);
      }
      return out.join('\n\n');
    },
    async voiceStatus() { return api.voice.status(); },
  };
  // ---------- live dictation: raw PCM recording + on-the-fly transcription ----------
  function wavBlob(pcm, rate) {
    const n = pcm.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return new Blob([buf], { type: 'audio/wav' });
  }
  function resample(pcm, from, to) {
    if (from === to) return pcm; const ratio = from / to, n = Math.floor(pcm.length / ratio), out = new Float32Array(n);
    for (let i = 0; i < n; i++) { const p = i * ratio, i0 = Math.floor(p), f = p - i0; out[i] = pcm[i0] * (1 - f) + (pcm[Math.min(i0 + 1, pcm.length - 1)] || 0) * f; }
    return out;
  }
  // Records straight to 16 kHz mono PCM (no webm decoding step). onLevel(0..1) drives the waveform.
  Media.recordPcm = async function (onLevel) {
    const dev = A.settings.voice && A.settings.voice.deviceId;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(dev && dev !== 'default' ? { deviceId: { exact: dev } } : {}), channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    let ctx; try { ctx = new AudioContext({ sampleRate: 16000 }); } catch { ctx = new AudioContext(); }
    const src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1), mute = ctx.createGain(); mute.gain.value = 0;
    const chunks = []; let total = 0; const t0 = Date.now();
    proc.onaudioprocess = (e) => { const d = new Float32Array(e.inputBuffer.getChannelData(0)); chunks.push(d); total += d.length; if (onLevel) { let m = 0; for (let i = 0; i < d.length; i += 8) m = Math.max(m, Math.abs(d[i])); onLevel(Math.min(1, m * 2.5)); } };
    src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    const concat = () => { const o = new Float32Array(total); let p = 0; for (const c of chunks) { o.set(c, p); p += c.length; } return resample(o, ctx.sampleRate, 16000); };
    const close = () => { try { proc.disconnect(); src.disconnect(); } catch { } stream.getTracks().forEach((t) => t.stop()); ctx.close().catch(() => { }); };
    return { elapsed: () => (Date.now() - t0) / 1000, pcm: concat, stop() { const p = concat(); close(); return p; }, cancel: close };
  };
  // quick transcription of a PCM slice (used for the live preview); returns {text, language}
  Media.transcribeQuick = async function (pcm, onProgress) {
    const v = A.settings.voice || {}; const off = onProgress ? api.on('voice:progress', onProgress) : null;
    try { const r = await api.voice.transcribe({ audio: new Uint8Array(new Float32Array(pcm).buffer), model: v.model || 'small', language: v.language || 'auto' }); if (!r.ok) throw new Error(r.error || 'Transcription failed'); return r; }
    finally { off && off(); }
  };
  // a finished dictation → attachment (wav for playback, full-accuracy transcript)
  Media.attachPcm = function (pcm, name, opts = {}) {
    const blob = wavBlob(pcm, 16000);
    const att = { id: uuid(), kind: opts.voice ? 'voice' : 'audio', name, size: blob.size, blob, url: URL.createObjectURL(blob), status: 'working', stage: 'Transcribing…', transcript: '', frames: [], duration: pcm.length / 16000, progress: null };
    att.promise = (async () => {
      try { if (att.duration >= 0.3) { const r = await transcribePcm(pcm, att); att.transcript = (r.text || '').trim(); att.language = r.language; } att.status = 'ready'; }
      catch (e) { att.status = 'error'; att.error = e.message || String(e); }
      att.stage = ''; att.onUpdate && att.onUpdate(); return att;
    })();
    return att;
  };
  window.Media = Media;
})();
