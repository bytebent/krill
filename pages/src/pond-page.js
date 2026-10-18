/*
 * krill · pond page
 *
 * One pond object is the single source of truth. The sketch is the conductor's score, which is
 * cheap, so it's recomputed (debounced) whenever something that shapes the score changes; audio
 * renders only on Preview and Export, in the worker. Efficiency: the sketch canvas redraws only when
 * the score or the window size changes; during playback only the playhead layer redraws, from a
 * rAF loop that stops with the audio.
 */
(function () {
  'use strict';
  const K = window.Krill, C = K.creature, S = K.scales, PD = K.pond, CD = K.conductor, PAN = K.pan, kit = K.kit, el = kit.el;
  const { Rng } = K.rng;
  const STORE = 'krill.pond.v1', CREATURE_STORE = 'krill.creature.v1';
  const PREVIEW_MAX_MIN = 10;
  const MEMORY_MAX_MIN = 30;           // longest export built in memory (browsers without the save dialog)
  const STREAMS = typeof window.showSaveFilePicker === 'function';   // Chrome, Edge: write to disk as it renders
  const HEX = ['#61bb46', '#fdb827', '#f5821f', '#e03a3e', '#963d97', '#009ddc'];

  const example = () => PD.normalise(window.KRILL_POND_EXAMPLE).pond;
  let pond = example(), dirty = false, score = null;

  function save() { try { localStorage.setItem(STORE, JSON.stringify(pond)); } catch (e) { /* storage unavailable */ } }
  function changed(rescore) { dirty = true; showName(); save(); if (rescore !== false) rescoreSoon(); }
  const path = p => { const ks = p.split('.'); return { get: () => ks.reduce((o, k) => o[k], pond), set: v => { let o = pond; for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]]; o[ks[ks.length - 1]] = v; } }; };
  const randomSeed = () => { try { return (crypto.getRandomValues(new Uint32Array(1))[0] % 999999) + 1; } catch (e) { return 1 + Math.floor(Math.random() * 999999); } };

  // ---------- status, name ----------
  const statusEl = document.getElementById('status');
  const setStatus = (t, err) => { statusEl.textContent = t; statusEl.classList.toggle('err', !!err); };
  const nameEl = document.getElementById('name'), dirtyEl = document.getElementById('dirty');
  function showName() { if (document.activeElement !== nameEl) nameEl.value = pond.name; dirtyEl.hidden = !dirty; }
  nameEl.addEventListener('input', () => { pond.name = nameEl.value.trim() || 'Pond'; changed(false); });
  nameEl.addEventListener('blur', showName);

  // ---------- slots ----------
  const slotsEl = document.getElementById('slots');
  const fileIn = document.getElementById('file');
  let fileTarget = null;               // null = load a pond; a number = load a creature into that slot
  function slotRow(i) {
    const s = pond.slots[i], row = el('div', 'slot' + (s ? '' : ' empty'));
    const led = el('span', 'led'); led.style.background = HEX[i]; led.title = 'Slot ' + (i + 1);
    row.appendChild(led);
    const who = el('div');
    if (s) { who.append(el('div', 'nm', s.creature.name), el('div', 'sp', C.speciesLabel(s.creature) + (s.rerolls ? ' · re-rolled ' + s.rerolls + '×' : ''))); }
    else who.append(el('div', 'sp', 'Empty slot ' + (i + 1)));
    row.appendChild(who);
    const add = el('select', 'field'); add.setAttribute('aria-label', 'Put a creature in slot ' + (i + 1));
    add.appendChild(new Option(s ? 'Replace…' : 'Add creature…', ''));
    for (const ex of window.KRILL_EXAMPLES || []) add.appendChild(new Option(ex.name, 'ex:' + ex.name));
    add.appendChild(new Option('From file…', 'file'));
    add.addEventListener('change', () => {
      const v = add.value; add.value = '';
      if (v === 'file') { fileTarget = i; fileIn.click(); return; }
      const ex = (window.KRILL_EXAMPLES || []).find(e => 'ex:' + e.name === v);
      if (ex) putCreature(i, ex);
    });
    if (!s) { row.append(add, el('span'), el('span')); return row; }
    const box = el('div'); row.appendChild(box);
    kit.Seg(box, { options: [[false, 'Talks'], [true, 'Ignores']], get: () => s.ignore, set: v => { s.ignore = v; changed(); },
      label: null }).el.title = 'Ignores: speaks on its own, outside the conversation';
    const rbox = el('div'); row.appendChild(rbox);
    kit.Range(rbox, { name: 'Loudness', min: -24, max: 0, unit: 'dB', c: HEX[i], round: 0.5,
      title: 'Each call is drawn from this range, at most 0 dB, so a lane only gets quieter. Drag the top down if a lane is too loud',
      get: () => s.loudness, set: ([a, b]) => { s.loudness = [Math.min(0, a, b), Math.min(0, Math.max(a, b))]; changed(); } });
    const btns = el('div', 'btns');
    const b = (label, title, fn) => { const x = el('button', 'gel grey small', label); x.type = 'button'; x.title = title; x.addEventListener('click', fn); btns.appendChild(x); return x; };
    b('↻', 'Re-roll this creature: new calls, the others stay', () => { s.rerolls++; changed(); buildSlots(); });
    b('Edit', 'Open this creature in the creature page', () => {
      try { localStorage.setItem(CREATURE_STORE, JSON.stringify(s.creature)); } catch (e) { /* ignore */ }
      location.href = 'creature.html';
    });
    btns.appendChild(add);
    b('✕', 'Remove from the pond', () => { pond.slots[i] = null; changed(); buildSlots(); });
    row.appendChild(btns);
    return row;
  }
  function putCreature(i, c) {
    const r = C.normalise(c);
    pond.slots[i] = Object.assign(PD.slotFor(r.creature), pond.slots[i] ? { ignore: pond.slots[i].ignore, loudness: pond.slots[i].loudness } : {});
    changed(); buildSlots();
    setStatus(r.creature.name + ' in slot ' + (i + 1) + (r.warnings.length ? ' · fixed: ' + r.warnings.join('; ') : ''));
  }
  function buildSlots() { slotsEl.textContent = ''; for (let i = 0; i < PD.SLOTS; i++) slotsEl.appendChild(slotRow(i)); }

  // ---------- settings ----------
  const controls = [];
  const F = {}; for (const f of PD.FIELDS) F[f.path] = f;
  const knob = (host, p, name, opt) => { const f = F[p], g = path(p); controls.push(kit.Knob(host, Object.assign({ name, min: f.min, max: f.max, def: f.def, get: g.get, set: v => { g.set(+v.toFixed(3)); changed(opt && opt.rescore); } }, opt || {}))); };
  {
    const gp = document.getElementById('g-pitch');
    const rootSel = el('select', 'field'), scaleSel = el('select', 'field');
    for (const r of S.ROOTS) rootSel.appendChild(new Option(r, r));
    for (const sc in S.SCALES) scaleSel.appendChild(new Option(sc, sc));
    const mode = kit.Seg(gp, { label: 'Key', options: [['key', 'In key'], ['free', 'Free']], get: () => pond.pitch.mode,
      set: v => { pond.pitch = v === 'key' ? { mode: 'key', root: rootSel.value || 'D', scale: scaleSel.value || 'minor', harmonise: false } : { mode: 'free', harmonise: false }; showPitch(); changed(); } });
    const wrap = el('div', 'segwrap'); wrap.append(el('span', null, 'Root · scale'));
    const sel = el('div'); sel.style.display = 'flex'; sel.style.gap = '6px'; sel.append(rootSel, scaleSel); wrap.appendChild(sel); gp.appendChild(wrap);
    const harm = kit.Seg(gp, { label: 'Harmonise', options: [[false, 'Off'], [true, 'On']], get: () => !!pond.pitch.harmonise, set: v => { pond.pitch.harmonise = v; changed(); } });
    rootSel.addEventListener('change', () => { pond.pitch.root = rootSel.value; changed(); });
    scaleSel.addEventListener('change', () => { pond.pitch.scale = scaleSel.value; changed(); });
    function showPitch() {
      const key = pond.pitch.mode === 'key';
      rootSel.disabled = scaleSel.disabled = !key; harm.el.style.opacity = key ? '' : '.45'; harm.el.style.pointerEvents = key ? '' : 'none';
      if (key) { rootSel.value = pond.pitch.root; scaleSel.value = pond.pitch.scale; }
      mode.show(); harm.show();
    }
    controls.push({ show: showPitch });
    const gt = document.getElementById('g-talk');
    knob(gt, 'talk.overlap', 'Overlap', { title: '0 strict turns … 1 everyone talks freely' });
    knob(gt, 'talk.chaos', 'Chaos', { fmt: v => Math.round(v * 100) + '%', title: 'More answers and copies at around the same time: 0 calm turns … 1 everyone piles in' });
    knob(gt, 'talk.eraLength', 'Era length', { scale: 'log', fmt: v => v >= 60 ? (+(v / 60).toFixed(1)) + ' min' : Math.round(v) + ' s', title: 'How often the pond\'s density and register drift a step' });
    const f = F['talk.response'], g = path('talk.response');
    controls.push(kit.Range(document.getElementById('g-talk-r'), { name: 'Response', min: f.min, max: f.max, scale: 'log', unit: 's', round: 0.01,
      title: 'Gap before an answer', get: g.get, set: v => { g.set(v); changed(); } }));
    const go = document.getElementById('g-out');
    knob(go, 'space.width', 'Width', { rescore: false });
    knob(go, 'output.level', 'Level', { fmt: v => (+v.toFixed(1)) + ' dB', rescore: false });
    const ex = document.getElementById('exOut');            // the rest of Output lives in the Export sheet
    knob(ex, 'output.fadeIn', 'Fade in', { fmt: v => Math.round(v) + ' s', rescore: false });
    knob(ex, 'output.fadeOut', 'Fade out', { fmt: v => Math.round(v) + ' s', rescore: false });
    controls.push(kit.Seg(ex, { label: 'Bits', options: [[16, '16'], [24, '24']], get: () => pond.output.bits, set: v => { pond.output.bits = v; changed(false); showExport(); } }));
  }
  const seedEl = document.getElementById('seed'), minEl = document.getElementById('minutes');
  seedEl.addEventListener('change', () => { const v = parseInt(seedEl.value, 10); if (v > 0) { pond.seed = v; changed(); } showFields(); });
  document.getElementById('dice').addEventListener('click', () => { pond.seed = randomSeed(); showFields(); changed(); });
  minEl.addEventListener('change', () => { const v = parseFloat(minEl.value); if (v > 0) { pond.output.minutes = Math.min(600, Math.max(0.1, v)); changed(); } showFields(); });
  function showFields() {
    seedEl.value = pond.seed; minEl.value = +pond.output.minutes.toFixed(2);
    const long = pond.output.minutes > PREVIEW_MAX_MIN;
    document.getElementById('render').textContent = long ? 'Preview first ' + PREVIEW_MAX_MIN + ' min' : 'Preview';
    showExport();
  }
  function refreshAll() { showName(); buildSlots(); for (const c of controls) c.show(); showFields(); }

  // ---------- sketch ----------
  const skC = document.getElementById('sketch'), topC = document.getElementById('sketchTop');
  let timer = null;
  function rescoreSoon() { clearTimeout(timer); timer = setTimeout(rescore, 120); }
  function rescore() {
    const t = performance.now();
    try { score = CD.conduct(pond); } catch (e) { score = null; setStatus('Could not score the pond: ' + e.message, true); }
    drawSketch(); showReadouts(performance.now() - t);
  }
  function fit(c) {
    const r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return c.getContext('2d');
  }
  let layout = null;
  function drawSketch() {
    const g = fit(skC), W = skC.width, H = skC.height, d = window.devicePixelRatio || 1;
    g.fillStyle = '#060608'; g.fillRect(0, 0, W, H);
    if (!score) return;
    const secs = score.seconds, x0 = 34 * d, x1 = W - 8 * d, X = t => x0 + t / secs * (x1 - x0);
    const eraH = 18 * d, panH = 54 * d, laneTop = eraH + 6 * d, laneH = (H - laneTop - panH - 10 * d) / PD.SLOTS;
    layout = { X, x0, x1, H };
    g.font = (9.5 * d) + 'px Monaco, monospace'; g.textBaseline = 'middle';
    // era density, as a line across the top
    g.strokeStyle = 'rgba(136,255,136,.6)'; g.lineWidth = 1 * d; g.beginPath();
    score.eras.forEach((e, k) => { const px = X(e.t), py = 4 * d + (1 - (Math.log(e.density) + 0.9) / 1.8) * (eraH - 8 * d); if (k) g.lineTo(px, py); else g.moveTo(px, py); });
    g.stroke();
    g.fillStyle = 'rgba(136,255,136,.7)'; g.fillText('ERA', 4 * d, eraH / 2);
    // lanes
    const yOf = s => laneTop + s * laneH;
    for (let s = 0; s < PD.SLOTS; s++) {
      g.fillStyle = 'rgba(255,255,255,.04)'; g.fillRect(x0, yOf(s) + 1, x1 - x0, laneH - 2);
      g.fillStyle = score.slots[s] ? HEX[s] : '#333'; g.fillText(String(s + 1), 8 * d, yOf(s) + laneH / 2);
    }
    const many = score.calls.length > 1500;
    if (!many) {
      g.strokeStyle = 'rgba(200,200,210,.35)'; g.lineWidth = 1 * d;
      for (const c of score.calls) if (c.of != null) {
        const src = score.calls[c.of];
        g.beginPath(); g.moveTo(X(src.end), yOf(src.slot) + laneH / 2); g.lineTo(X(c.t), yOf(c.slot) + laneH / 2); g.stroke();
      }
    }
    for (const c of score.calls) {
      const a = Math.pow(10, (c.gainDb || 0) / 40);                // quieter calls draw fainter
      g.globalAlpha = 0.35 + 0.65 * a;
      g.fillStyle = HEX[c.slot];
      const px = X(c.t), w = Math.max(1.5 * d, X(c.end) - px), top = yOf(c.slot) + laneH * 0.18, h = laneH * 0.64;
      g.fillRect(px, top, w, h);
      if (c.kind === 'copy') { g.globalAlpha = 1; g.strokeStyle = '#fff'; g.lineWidth = 1 * d; g.strokeRect(px + 0.5, top + 0.5, w - 1, h - 1); }
    }
    g.globalAlpha = 1;
    // pan: where each call sits while it sounds (the voice's own math: home, wander, answer lean,
    // Width), left at the top of the strip, centre dashed, right at the bottom
    const py0 = H - panH - 4 * d, PY = p => py0 + 3 * d + (p + 1) / 2 * (panH - 6 * d);
    g.fillStyle = 'rgba(255,255,255,.04)'; g.fillRect(x0, py0, x1 - x0, panH);
    g.strokeStyle = 'rgba(136,255,136,.25)'; g.lineWidth = 1; g.setLineDash([3 * d, 4 * d]);
    g.beginPath(); g.moveTo(x0, PY(0)); g.lineTo(x1, PY(0)); g.stroke(); g.setLineDash([]);
    g.fillStyle = 'rgba(136,255,136,.7)';
    g.fillText('L', 8 * d, PY(-1)); g.fillText('C', 8 * d, PY(0)); g.fillText('R', 8 * d, PY(1));
    g.lineWidth = 2 * d; g.lineCap = 'round';
    for (const c of score.calls) {
      const sl = score.slots[c.slot]; if (!sl) continue;
      const n = Math.max(1, Math.min(8, Math.ceil((c.end - c.t) / 2)));
      g.strokeStyle = HEX[c.slot]; g.beginPath();
      for (let k = 0; k <= n; k++) {
        const t = c.t + (c.end - c.t) * k / n, px = X(t), py = PY(PAN.slotPanAt(pond, c.slot, sl, t, c.lean));
        if (k) g.lineTo(px, py); else g.moveTo(px, py);
      }
      g.lineTo(Math.max(X(c.end), X(c.t) + 1.5 * d), PY(PAN.slotPanAt(pond, c.slot, sl, c.end, c.lean)));
      g.stroke();
    }
    g.lineCap = 'butt';
    // minute ticks
    g.fillStyle = 'rgba(136,255,136,.5)';
    const step = secs > 1200 ? 300 : secs > 300 ? 60 : secs > 60 ? 10 : 5;
    for (let t = step; t < secs; t += step) g.fillRect(X(t), H - 6 * d, 1, 4 * d);
  }
  function showReadouts(ms) {
    const ro = document.getElementById('ro'); ro.textContent = '';
    const add = (b, v) => { const s = el('span'); s.append(el('b', null, b), document.createTextNode(v)); ro.appendChild(s); };
    if (!score) return;
    const m = Math.floor(score.seconds / 60), s = Math.round(score.seconds % 60);
    add('SEED', String(pond.seed)); add('KEY', score.pitch + (pond.pitch.harmonise ? ' · HARMONISE' : ''));
    add('LEN', m + ':' + String(s).padStart(2, '0'));
    add('CALLS', String(score.calls.length));
    add('ANSWERS', String(score.calls.filter(c => c.depth > 0).length));
    add('COPIES', String(score.calls.filter(c => c.kind === 'copy').length));
    add('SCORED', Math.round(ms) + ' MS');
  }
  function drawTop(t) {
    const g = fit(topC); g.clearRect(0, 0, topC.width, topC.height);
    if (!layout || t < 0 || !score) return;
    const px = layout.X(Math.min(t, score.seconds));
    g.fillStyle = '#fff'; g.shadowColor = '#fff'; g.shadowBlur = 8; g.fillRect(px, 0, 2, topC.height); g.shadowBlur = 0;
  }
  new ResizeObserver(() => { drawSketch(); drawTop(-1); }).observe(skC);

  // ---------- render preview ----------
  const worker = new Worker(URL.createObjectURL(new Blob([document.getElementById('worker-src').textContent], { type: 'text/javascript' })));
  let jobId = 0; const jobs = {};
  worker.onmessage = e => {
    const m = e.data, j = jobs[m.id]; if (!j) return;
    if (m.type === 'progress') { j.progress(m.p); return; }
    delete jobs[m.id];
    if (m.type === 'error') j.reject(new Error(m.message)); else j.resolve(m.result);
  };
  worker.onerror = e => setStatus('Render worker failed: ' + (e.message || 'unknown error'), true);
  const job = (msg, progress) => new Promise((resolve, reject) => { const id = ++jobId; jobs[id] = { resolve, reject, progress }; worker.postMessage(Object.assign({ id }, msg)); });
  const audio = document.getElementById('audio'), player = document.getElementById('player');
  const renderBtn = document.getElementById('render'), prog = document.getElementById('prog'), progBar = prog.firstChild;
  let wavUrl = null, wavName = '';
  renderBtn.addEventListener('click', async () => {
    if (renderBtn.disabled || exporting) return;
    if (!pond.slots.some(Boolean)) { setStatus('Put a creature in a slot first', true); return; }
    renderBtn.disabled = true; prog.style.display = 'block'; progBar.style.width = '0';
    const seconds = Math.min(pond.output.minutes, PREVIEW_MAX_MIN) * 60;
    setStatus('Rendering ' + Math.round(seconds / 60 * 10) / 10 + ' min…');
    const t = performance.now();
    try {
      const r = await job({ type: 'pond', pond, seconds }, p => { progBar.style.width = (p * 100) + '%'; });
      if (wavUrl) URL.revokeObjectURL(wavUrl);
      wavUrl = URL.createObjectURL(new Blob([r.bytes], { type: 'audio/wav' }));
      wavName = r.fileName;
      audio.src = wavUrl; player.hidden = false;
      audio.play().catch(() => { /* the user can press play */ });
      setStatus('Rendered ' + r.calls + ' calls in ' + ((performance.now() - t) / 1000).toFixed(1) + ' s');
    } catch (e) { setStatus('Could not render: ' + e.message, true); }
    renderBtn.disabled = false; prog.style.display = 'none';
  });
  document.getElementById('dl').addEventListener('click', () => { if (wavUrl) download(wavUrl, wavName); });
  const loop = () => { if (audio.paused) { drawTop(audio.currentTime > 0 ? audio.currentTime : -1); return; } drawTop(audio.currentTime); requestAnimationFrame(loop); };
  audio.addEventListener('play', loop);
  audio.addEventListener('seeked', () => drawTop(audio.currentTime));
  topC.parentElement.addEventListener('click', e => {        // click the sketch to jump there
    if (!layout || player.hidden || !score) return;
    const r = skC.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    const t = ((e.clientX - r.left) * d - layout.x0) / (layout.x1 - layout.x0) * score.seconds;
    if (t >= 0 && t <= (audio.duration || 0)) { audio.currentTime = t; drawTop(t); }
  });

  // ---------- export ----------
  // The sheet edits the pond's own output settings (length, fades, bits), so the pond file saved
  // with the WAV re-renders exactly that piece. Chrome and Edge stream to disk through the save
  // dialog; other browsers build the WAV in memory, up to MEMORY_MAX_MIN.
  const sheet = document.getElementById('exportSheet'), exMin = document.getElementById('exMin');
  const exNote = document.getElementById('exNote'), exGo = document.getElementById('exGo'), exCancel = document.getElementById('exCancel');
  const exProg = document.getElementById('exProg'), exBar = exProg.firstChild, exPond = document.getElementById('exPond');
  const LENGTHS = [1, 5, 10, 20, 30, 60];
  const lenSeg = kit.Seg(document.getElementById('exLenSeg'), { options: LENGTHS.map(m => [m, String(m)]), get: () => pond.output.minutes,
    set: v => { pond.output.minutes = v; changed(); showFields(); } });
  exMin.addEventListener('change', () => { const v = parseFloat(exMin.value); if (v > 0) { pond.output.minutes = Math.min(600, Math.max(0.1, v)); changed(); } showFields(); });
  let exporting = null;                // { stop } while an export runs
  const mb = b => b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : Math.round(b / 1e6) + ' MB';
  function showExport() {
    if (!exMin) return;
    lenSeg.show();
    if (document.activeElement !== exMin) exMin.value = +pond.output.minutes.toFixed(2);
    const bytes = pond.output.minutes * 60 * 48000 * 2 * pond.output.bits / 8, name = PD.exportName(pond);
    const tooLong = !STREAMS && pond.output.minutes > MEMORY_MAX_MIN;
    exNote.textContent = '';
    exNote.append(name + '.wav, about ' + mb(bytes) + '. ');
    if (STREAMS) exNote.append('It is written to disk as it renders, so any length works.');
    else if (!tooLong) exNote.append('This browser builds the WAV in memory, up to ' + MEMORY_MAX_MIN + ' minutes (Chrome and Edge can save longer pieces).');
    else {
      exNote.append('That is longer than this browser can hold in memory (' + MEMORY_MAX_MIN + ' min). Use Chrome or Edge, or save the pond and run ');
      const c = el('span'); c.id = 'cmd'; c.textContent = 'node tools/render.js ' + name + '.krill-pond.json'; exNote.appendChild(c);
    }
    exGo.disabled = tooLong || !!exporting;
  }
  function openSheet() { if (!pond.slots.some(Boolean)) { setStatus('Put a creature in a slot first', true); return; } for (const c of controls) c.show(); showExport(); sheet.hidden = false; exGo.focus(); }
  function closeSheet() { if (exporting) exporting.stop(); else sheet.hidden = true; }
  document.getElementById('export').addEventListener('click', openSheet);
  exCancel.addEventListener('click', closeSheet);
  sheet.addEventListener('click', e => { if (e.target === sheet && !exporting) closeSheet(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });
  function savePondFile(p, base) {
    const u = URL.createObjectURL(new Blob([PD.serialise(p)], { type: 'application/json' }));
    download(u, base + '.krill-pond.json'); setTimeout(() => URL.revokeObjectURL(u), 5000);
  }
  exGo.addEventListener('click', async () => {
    if (exporting || exGo.disabled) return;
    const p = PD.normalise(JSON.parse(JSON.stringify(pond))).pond, name = PD.exportName(p);
    let file = null;
    if (STREAMS) {
      try {
        const h = await window.showSaveFilePicker({ suggestedName: name + '.wav', types: [{ description: 'WAV audio', accept: { 'audio/wav': ['.wav'] } }] });
        file = await h.createWritable();
      } catch (e) { if (e && e.name === 'AbortError') return; setStatus('Could not open the file: ' + e.message, true); return; }
    }
    let stopped = false;
    exporting = { stop: () => { stopped = true; } };
    exGo.disabled = true; renderBtn.disabled = true; exCancel.textContent = 'Stop'; exProg.style.display = 'block'; exBar.style.width = '0';
    const t = performance.now(), parts = [];
    try {
      const info = await job({ type: 'exportStart', pond: p });
      let r;
      do {
        r = await job({ type: 'exportStep', seconds: 10 });
        if (stopped) break;
        if (file) await file.write(r.bytes); else parts.push(r.bytes);
        exBar.style.width = (r.progress * 100) + '%';
        setStatus('Exporting ' + Math.round(r.progress * 100) + '%');
      } while (!r.done);
      if (stopped) {
        await job({ type: 'exportStop' });
        if (file) await file.abort().catch(() => {});
        setStatus('Export stopped');
      } else {
        if (file) { await file.write({ type: 'write', position: 0, data: r.header }); await file.close(); }
        else {
          parts[0].set(r.header, 0);
          const u = URL.createObjectURL(new Blob(parts, { type: 'audio/wav' }));
          download(u, info.fileName); setTimeout(() => URL.revokeObjectURL(u), 60000);
        }
        if (exPond.checked) savePondFile(p, info.base);
        setStatus('Exported ' + info.fileName + (exPond.checked ? ' and its pond file' : '') + ' in ' + ((performance.now() - t) / 1000).toFixed(1) + ' s');
        sheet.hidden = true;
      }
    } catch (e) {
      if (file) await file.abort().catch(() => {});
      setStatus('Could not export: ' + e.message, true);
    }
    exporting = null; exCancel.textContent = 'Cancel'; exProg.style.display = 'none'; renderBtn.disabled = false; showExport();
  });

  // ---------- files ----------
  function download(url, name) { const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
  document.getElementById('save').addEventListener('click', () => {
    const u = URL.createObjectURL(new Blob([PD.serialise(pond)], { type: 'application/json' }));
    download(u, PD.fileName(pond)); setTimeout(() => URL.revokeObjectURL(u), 5000);
    dirty = false; showName(); setStatus('Saved ' + PD.fileName(pond));
  });
  document.getElementById('load').addEventListener('click', () => { fileTarget = null; fileIn.click(); });
  fileIn.addEventListener('change', () => { const f = fileIn.files[0]; fileIn.value = ''; if (f) readFile(f, fileTarget); });
  // a krill WAV carries the pond it was made from in its krll chunk (before the audio)
  function readWav(f) {
    f.slice(0, 4 << 20).arrayBuffer().then(buf => {
      let info; try { info = K.wav.parse(new Uint8Array(buf)); } catch (e) { setStatus(f.name + ' is not a WAV file', true); return; }
      if (!info.meta || !info.meta.pond) { setStatus(f.name + ' was not made by krill, so it has no pond in it', true); return; }
      const p = info.meta.pond;
      if (info.meta.seconds) p.output = Object.assign({}, p.output, { minutes: info.meta.seconds / 60 });
      loadPond(p); setStatus('Opened the pond from ' + f.name);
    });
  }
  function readFile(f, slot) {
    f.slice(0, 12).arrayBuffer().then(b => {       // a WAV by its contents, whatever its name
      const u = new Uint8Array(b), id = o => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
      if (u.length === 12 && id(0) === 'RIFF' && id(8) === 'WAVE') { if (slot == null) readWav(f); else setStatus('A WAV opens as a pond: use Load…', true); }
      else readJson(f, slot);
    });
  }
  function readJson(f, slot) {
    f.text().then(txt => {
      let o; try { o = JSON.parse(txt); } catch (e) { setStatus(f.name + ' is not JSON', true); return; }
      try {
        if (o.format === PD.FORMAT && slot == null) { loadPond(o); setStatus('Loaded ' + f.name); }
        else if (o.format !== PD.FORMAT) {
          const i = slot != null ? slot : pond.slots.findIndex(s => !s);
          if (i < 0) { setStatus('All six slots are full', true); return; }
          putCreature(i, o);
        } else setStatus('That is a pond file; use Load… to open it', true);
      } catch (e) { setStatus(f.name + ': ' + e.message, true); }
    });
  }
  function loadPond(o) { const r = PD.normalise(o); pond = r.pond; dirty = false; refreshAll(); save(); rescore(); if (r.warnings.length) setStatus('Fixed: ' + r.warnings.join('; '), true); return r.warnings; }
  document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dropping'); });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  document.addEventListener('drop', e => { e.preventDefault(); document.body.classList.remove('dropping'); const f = e.dataTransfer.files[0]; if (f) readFile(f, null); });
  document.getElementById('example').addEventListener('click', () => { loadPond(window.KRILL_POND_EXAMPLE); setStatus('Example pond loaded'); });
  document.getElementById('new').addEventListener('click', () => { loadPond(PD.defaults({ name: 'Pond', seed: randomSeed() })); dirty = true; showName(); setStatus('New empty pond: add creatures to the slots'); });

  // ---------- start ----------
  let start = null;
  try { start = JSON.parse(localStorage.getItem(STORE)); } catch (e) { start = null; }
  try { if (start) pond = PD.normalise(start).pond; } catch (e) { pond = example(); }
  refreshAll(); rescore();
  window.krillPond = { get pond() { return pond; }, get score() { return score; }, load: loadPond, rescore };   // for tests
})();
