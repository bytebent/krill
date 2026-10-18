/*
 * krill · visualizer page
 *
 * A circle with each creature as a scope of its own voice. Left to right is the pan you hear;
 * up and down is a seeded height that drifts with the eras; size is the call's loudness; a scope
 * fades with its own level, so a silent creature isn't drawn. Answers pass a ball along a solid
 * white line, copies draw a dotted one (src/scene.js).
 *
 * Two ways to play:
 *   live  the pond renders in real time in an AudioWorklet (Pond length, or Endless)
 *   wav   a krill WAV plays in the audio element; the worklet runs the same pond silently next
 *         to it, following its time, for the scopes
 * Efficiency: drawing runs from rAF only while playing; the scene is a lookup into the score.
 */
(function () {
  'use strict';
  const K = window.Krill, PD = K.pond, CD = K.conductor, SC = K.scene, kit = K.kit, el = kit.el;
  const POND_STORE = 'krill.pond.v1';
  const SR = 48000, SCOPE = 512, ENDLESS_H = 6;
  const HEX = ['#61bb46', '#fdb827', '#f5821f', '#e03a3e', '#963d97', '#009ddc'];

  const statusEl = document.getElementById('status');
  const setStatus = (t, err) => { statusEl.textContent = t; statusEl.classList.toggle('err', !!err); };

  // ---------- what plays ----------
  let pond = null, mode = 'live', endless = true, wav = null;   // wav: { url, name, seconds }
  let score = null, scene = null, seconds = 0;
  const audio = document.getElementById('audio'), player = document.getElementById('player');
  function stored() { try { const s = localStorage.getItem(POND_STORE); return s ? PD.normalise(JSON.parse(s)).pond : null; } catch (e) { return null; } }
  function setPond(p, how, wavInfo) {
    stop();
    pond = PD.normalise(p).pond;
    if (wav && wav.url) URL.revokeObjectURL(wav.url);
    wav = wavInfo || null; mode = wav ? 'wav' : 'live';
    player.hidden = !wav;
    if (wav) { audio.src = wav.url; } else audio.removeAttribute('src');
    rescore();
    document.getElementById('name').textContent = pond.name + (wav ? ' · ' + wav.name : '');
    lenSeg.el.hidden = !!wav;
    setStatus(how);
    loaded = false;
    drawFrame(0);
  }
  function rescore() {
    seconds = mode === 'wav' ? wav.seconds : endless ? ENDLESS_H * 3600 : pond.output.minutes * 60;
    score = CD.conduct(pond, { seconds });
    scene = SC.makeScene(pond, score);
    showReadouts(0);
  }

  // ---------- audio ----------
  let ctx = null, node = null, loaded = false, playing = false, startedAt = 0, base = 0;
  async function ensureNode() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR, latencyHint: 'playback' });
      const src = 'const self = globalThis;\n' + document.getElementById('worklet-src').textContent;
      // a blob URL first; pages opened from disk (file://) refuse those, so then a data: URL
      try { await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); }
      catch (e) { await ctx.audioWorklet.addModule('data:text/javascript;charset=utf-8,' + encodeURIComponent(src)); }
      node = new AudioWorkletNode(ctx, 'krill-player', { numberOfInputs: 0, outputChannelCount: [2] });
      node.connect(ctx.destination);
      node.port.onmessage = e => onPlayer(e.data);
    }
    if (ctx.state !== 'running') await ctx.resume();
    if (!loaded) {
      await new Promise((resolve, reject) => {
        readyWait = { resolve, reject };
        node.port.postMessage({ type: 'load', pond, seconds, mode });
      });
      loaded = true;
    }
  }
  let readyWait = null;
  function onPlayer(m) {
    if (m.type === 'ready' && readyWait) { readyWait.resolve(); readyWait = null; }
    else if (m.type === 'error') { if (readyWait) { readyWait.reject(new Error(m.message)); readyWait = null; } else setStatus('Player: ' + m.message, true); }
    else if (m.type === 'scope') takeScope(m);
    else if (m.type === 'ended') { pause(); setStatus('The end of the piece'); }
  }
  // where the listener is, in seconds of the piece
  function now() {
    if (mode === 'wav') return audio.currentTime || 0;
    if (!ctx || !playing) return base;
    const lat = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
    return Math.max(0, base + ctx.currentTime - startedAt - lat);
  }
  let starting = false;
  async function play() {
    if (starting || playing) return;
    if (!pond || !pond.slots.some(Boolean)) { setStatus('This pond has no creatures', true); return; }
    starting = true;
    try {
      document.getElementById('play').disabled = true;
      if (!loaded) setStatus(mode === 'live' ? 'Starting the pond…' : 'Starting…');
      await ensureNode();
      if (mode === 'wav') await audio.play();
      else { startedAt = ctx.currentTime; }
      node.port.postMessage({ type: 'play' });
      playing = true; showPlay(); setStatus(mode === 'live' ? 'Playing live' : 'Playing ' + wav.name);
      document.getElementById('hint').hidden = true;
      requestAnimationFrame(loop);
    } catch (e) { setStatus('Could not play: ' + e.message, true); }
    starting = false;
    document.getElementById('play').disabled = false;
  }
  function pause() {
    if (!playing) return;
    if (mode === 'live') base = now();
    playing = false;
    if (node) node.port.postMessage({ type: 'pause' });
    if (mode === 'wav') audio.pause();
    showPlay();
  }
  function stop() {                                  // a new pond: the worklet starts again
    pause();
    base = 0; scopes = {}; levels = {};
    if (mode === 'wav' && audio.src) { audio.pause(); }
  }
  function showPlay() { document.getElementById('play').textContent = playing ? 'Pause' : 'Play'; }
  document.getElementById('play').addEventListener('click', () => playing ? pause() : play());
  // the audio element's own controls drive wav mode too
  audio.addEventListener('play', () => { if (!playing && mode === 'wav') play(); });
  audio.addEventListener('pause', () => { if (playing && mode === 'wav') { playing = false; if (node) node.port.postMessage({ type: 'pause' }); showPlay(); } });
  audio.addEventListener('seeked', () => { if (node) node.port.postMessage({ type: 'sync', t: audio.currentTime }); scopes = {}; drawFrame(audio.currentTime); });
  audio.addEventListener('ended', () => { pause(); setStatus('The end of the piece'); });

  // ---------- scopes ----------
  let scopes = {}, levels = {}, lastScopeAt = 0, scopeFrame = 0;
  function takeScope(m) {
    m.slots.forEach((slot, v) => { scopes[slot] = m.data.subarray(v * SCOPE, (v + 1) * SCOPE); });
    lastScopeAt = performance.now(); scopeFrame = m.frame;
  }

  // ---------- drawing ----------
  const cv = document.getElementById('vis');
  function fit() {
    const d = window.devicePixelRatio || 1, w = Math.round(cv.clientWidth * d), h = Math.round(cv.clientHeight * d);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    return cv.getContext('2d');
  }
  let lastDraw = 0;
  function drawFrame(t) {
    const g = fit(), W = cv.width, H = cv.height, d = window.devicePixelRatio || 1;
    const dt = lastDraw ? Math.min(0.1, (performance.now() - lastDraw) / 1000) : 0; lastDraw = performance.now();
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    g.fillStyle = '#060608'; g.fillRect(0, 0, W, H);
    const R = Math.min(W, H) / 2 - 14 * d, cx = W / 2, cy = H / 2;
    g.strokeStyle = 'rgba(136,255,136,.28)'; g.lineWidth = 1 * d;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(136,255,136,.10)'; g.setLineDash([2 * d, 6 * d]);
    g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.stroke(); g.setLineDash([]);
    g.font = (10 * d) + 'px Monaco, monospace'; g.textBaseline = 'middle'; g.textAlign = 'center';
    g.fillStyle = 'rgba(136,255,136,.6)'; g.fillText('L', cx - R - 8 * d, cy); g.fillText('R', cx + R + 8 * d, cy);
    if (!scene) return;
    const f = scene.at(t), P = w => [cx + w.x * R, cy - w.y * R];
    frame = f;
    g.globalCompositeOperation = 'lighter';
    // links: answers solid with a ball, copies dotted
    for (const l of f.links) {
      const a = f.where[l.from], b = f.where[l.to]; if (!a || !b) continue;
      const [x0, y0] = P(a), [x1, y1] = P(b);
      g.globalAlpha = 0.75 * Math.max(0, l.alpha);
      g.strokeStyle = '#fff'; g.lineWidth = 1.3 * d;
      g.setLineDash(l.dotted ? [1.5 * d, 5 * d] : []); g.lineCap = 'round';
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      g.setLineDash([]);                       // small dots at the ends, so a line never ends in empty space
      for (const [px, py, sl] of [[x0, y0, l.from], [x1, y1, l.to]]) { g.fillStyle = HEX[sl]; g.beginPath(); g.arc(px, py, 2.4 * d, 0, Math.PI * 2); g.fill(); }
      if (l.ball != null) {
        const p = l.ball, bx = x0 + (x1 - x0) * p, by = y0 + (y1 - y0) * p;
        g.globalAlpha = 1; g.fillStyle = '#fff';
        g.beginPath(); g.arc(bx, by, 3.6 * d, 0, Math.PI * 2); g.fill();
        g.globalAlpha = 0.25; g.beginPath(); g.arc(bx, by, 8 * d, 0, Math.PI * 2); g.fill();
      }
    }
    g.setLineDash([]);
    // creatures: a ring scope of the creature's own voice, as big as the call is loud, as bright
    // as its level; silent creatures don't show
    for (const w of f.where) {
      if (!w) continue;
      const s = scopes[w.slot];
      let rms = 0;
      if (s) { for (let i = 0; i < s.length; i++) rms += s[i] * s[i]; rms = Math.sqrt(rms / s.length); }
      const db = rms > 0 ? 20 * Math.log10(rms) : -120;
      const prev = levels[w.slot] == null ? -120 : levels[w.slot];
      const lv = Math.max(db, prev - 28 * dt);                // quick to light, about 1 s to fade
      levels[w.slot] = lv;
      const alpha = Math.max(0, Math.min(1, (lv + 52) / 26));
      if (alpha < 0.01 || !s) continue;
      const [x, y] = P(w), r0 = R * 0.085 * w.size, N = s.length;
      // start at an upward zero crossing so the shape holds still
      let k0 = 0; for (let i = 1; i < N / 2; i++) if (s[i - 1] < 0 && s[i] >= 0) { k0 = i; break; }
      const gain = rms > 0 ? Math.min(14, 0.32 / Math.max(rms, 0.01)) : 0, M = N - k0;
      g.strokeStyle = HEX[w.slot];
      for (const [lw, a] of [[5 * d, 0.18], [1.6 * d, 1]]) {
        g.globalAlpha = alpha * a; g.lineWidth = lw; g.beginPath();
        for (let i = 0; i <= M; i++) {
          const v = s[k0 + (i % M)] * gain, ang = (i / M) * Math.PI * 2 - Math.PI / 2;
          const rr = r0 * (1 + Math.max(-0.85, Math.min(1.4, v)));
          const px = x + Math.cos(ang) * rr, py = y + Math.sin(ang) * rr;
          if (i) g.lineTo(px, py); else g.moveTo(px, py);
        }
        g.stroke();
      }
      g.globalAlpha = alpha * 0.55; g.fillStyle = HEX[w.slot];
      g.fillText(w.name, x, y + r0 * 2.5 + 8 * d);
    }
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
  }
  let frame = null;
  function loop() {
    if (!playing) { drawFrame(now()); return; }
    const t = now();
    if (mode === 'wav' && node) node.port.postMessage({ type: 'sync', t: audio.currentTime });
    drawFrame(t); showTime(t);
    requestAnimationFrame(loop);
  }
  new ResizeObserver(() => drawFrame(now())).observe(cv);

  // ---------- readouts ----------
  const fmtT = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
  function showTime(t) {
    const end = mode === 'wav' ? wav.seconds : endless ? null : seconds;
    document.getElementById('time').textContent = fmtT(t) + (end ? ' / ' + fmtT(end) : '');
  }
  function showReadouts() {
    const ro = document.getElementById('ro'); ro.textContent = '';
    const add = (b, v) => { const s = el('span'); s.append(el('b', null, b), document.createTextNode(v)); ro.appendChild(s); };
    add('SEED', String(pond.seed)); add('KEY', score.pitch.toUpperCase());
    add('CREATURES', String(pond.slots.filter(Boolean).length));
    add('MODE', mode === 'wav' ? 'WAV' : endless ? 'LIVE · ENDLESS' : 'LIVE · ' + fmtT(seconds));
    showTime(base);
  }

  // ---------- length (live) ----------
  const lenSeg = kit.Seg(document.getElementById('lenBox'), { options: [[false, 'Pond length'], [true, 'Endless']], get: () => endless,
    set: v => { endless = v; stop(); loaded = false; rescore(); drawFrame(0); } });

  // ---------- files ----------
  const fileIn = document.getElementById('file');
  document.getElementById('load').addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', () => { const f = fileIn.files[0]; fileIn.value = ''; if (f) readFile(f); });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) readFile(f); });
  function readFile(f) {
    f.slice(0, 4 << 20).arrayBuffer().then(buf => {
      const u = new Uint8Array(buf), id = o => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
      if (u.length >= 12 && id(0) === 'RIFF' && id(8) === 'WAVE') {
        let info; try { info = K.wav.parse(u); } catch (e) { setStatus(f.name + ' is not a WAV file', true); return; }
        if (!info.meta || !info.meta.pond) { setStatus(f.name + ' was not made by krill, so it has no pond to show', true); return; }
        setPond(info.meta.pond, 'Opened ' + f.name + ': press Play', { url: URL.createObjectURL(f), name: f.name, seconds: info.meta.seconds || info.frames / info.sampleRate });
        return;
      }
      f.text().then(txt => {
        let o; try { o = JSON.parse(txt); } catch (e) { setStatus(f.name + ' is not a pond file or a krill WAV', true); return; }
        if (o.format !== PD.FORMAT) { setStatus(f.name + ' is not a pond file (creatures go in a pond first)', true); return; }
        setPond(o, 'Opened ' + f.name);
      });
    });
  }
  document.getElementById('example').addEventListener('click', () => setPond(window.KRILL_POND_EXAMPLE, 'The example pond'));
  document.getElementById('fromPond').addEventListener('click', () => { const p = stored(); if (p) setPond(p, 'The pond page\'s pond'); else setStatus('Nothing on the pond page yet', true); });

  // ---------- start ----------
  const p0 = stored();
  setPond(p0 || window.KRILL_POND_EXAMPLE, p0 ? 'The pond page\'s pond' : 'The example pond');
  window.krillVis = { get pond() { return pond; }, get scene() { return scene; }, get frame() { return frame; }, get scopes() { return scopes; }, get levels() { return levels; },
    get mode() { return mode; }, get scopeFrame() { return scopeFrame; }, get playing() { return playing; }, now, load: setPond };
})();
