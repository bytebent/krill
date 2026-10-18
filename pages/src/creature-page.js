/*
 * krill · creature page
 *
 * One creature object is the single source of truth. Every control reads and writes it; nothing
 * renders until Call, Signature or Render. Renders run in a worker so the page stays responsive.
 * Efficiency: the LCD's spectrogram and tube are drawn only when a call arrives or the window
 * resizes; while a call plays, only the playhead layer and the tube redraw (one rAF loop that
 * stops with the sound). Source and body panels are built from parts.js, so a new part shows up
 * here without page changes; the body panel isn't updated while the creature has no body.
 */
(function () {
  'use strict';
  const K = window.Krill, C = K.creature, S = K.scales, kit = K.kit, el = kit.el, PARTS = K.parts;
  const { Rng } = K.rng;
  const SR = 48000;
  const STORE = 'krill.creature.v1', STORE_PITCH = 'krill.previewPitch.v1';
  const COL = { krill: 'var(--graphite)' };

  // ---------- state ----------
  let creature = C.defaults('dolphin', 'none'), dirty = false;   // replaced at start-up by the saved or first example creature
  let previewPitch = { mode: 'key', root: 'D', scale: 'minor' };
  let seed = 1;                               // preview seed: each Call takes the next one
  const controls = [];                        // { show } for refreshAll
  let sourceControls = [], bodyControls = [], pad = null;

  function load(c) {
    const r = C.normalise(c);
    creature = r.creature;
    dirty = false;
    buildSource(); buildBody();
    refreshAll();
    save();
    return r.warnings;
  }
  function save() { try { localStorage.setItem(STORE, JSON.stringify(creature)); } catch (e) { /* storage unavailable */ } }
  function changed() { dirty = true; showName(); save(); }
  const R = key => creature.ranges[key] || [C.BY_KEY[key].def, C.BY_KEY[key].def];
  const path = (p) => { const parts = p.split('.'); return { get: () => parts.reduce((o, k) => o[k], creature), set: v => { let o = creature; for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]]; o[parts[parts.length - 1]] = v; } }; };

  // ---------- title bar ----------
  const nameEl = document.getElementById('name'), dirtyEl = document.getElementById('dirty');
  function showName() { if (document.activeElement !== nameEl) nameEl.value = creature.name; dirtyEl.hidden = !dirty; }
  nameEl.addEventListener('input', () => { creature.name = nameEl.value.trim() || 'Unnamed'; changed(); });
  nameEl.addEventListener('blur', showName);
  document.getElementById('dice').addEventListener('click', () => { creature.name = C.randomName(new Rng(randomSeed())); changed(); showName(); });
  function randomSeed() { try { return crypto.getRandomValues(new Uint32Array(1))[0]; } catch (e) { return (Math.random() * 4294967296) >>> 0; } }
  function showMark() {
    const m = document.getElementById('mark'); m.textContent = '';
    const cols = PARTS.SOURCES[creature.source].colors.concat(PARTS.BODIES[creature.body].colors);
    for (const c of cols) { const i = el('i'); i.style.background = c; m.appendChild(i); }
  }

  // ---------- species and pitch ----------
  const gSpecies = document.getElementById('g-species');
  controls.push(kit.Seg(gSpecies, {
    label: 'Source', options: C.SOURCES.map(id => [id, PARTS.SOURCES[id].label]),
    get: () => creature.source,
    set: v => { creature.source = v; fillDefaults(); buildSource(); refreshAll(); changed(); },
  }));
  controls.push(kit.Seg(gSpecies, {
    label: 'Body', options: C.BODIES.map(id => [id, PARTS.BODIES[id].label]),
    get: () => creature.body,
    set: v => { creature.body = v; fillDefaults(); buildBody(); refreshAll(); changed(); },
  }));
  // a newly chosen part starts from its defaults for any range the creature doesn't have yet
  function fillDefaults() {
    const d = C.defaults(creature.source, creature.body);
    for (const k in d.ranges) if (!creature.ranges[k]) creature.ranges[k] = d.ranges[k];
  }
  const gPitch = document.getElementById('g-pitch');
  controls.push(kit.Range(gPitch, {
    name: 'Notes', min: 12, max: 120, step: 1, c: COL.krill,
    fmt: v => S.noteName(v), title: 'Where calls start and settle (MIDI notes)',
    get: () => [creature.pitch.low, creature.pitch.high],
    set: ([a, b]) => { creature.pitch.low = a; creature.pitch.high = b; showPitchNote(); changed(); },
  }));
  controls.push(kit.Range(gPitch, {
    name: 'Contour', min: -24, max: 24, unit: 'st', c: COL.krill, round: 0.1,
    title: 'How far each unit glides from where it starts',
    get: () => creature.pitch.contour, set: v => { creature.pitch.contour = v; changed(); },
  }));
  const pitchNote = document.getElementById('pitchNote');
  function showPitchNote() {
    const src = PARTS.SOURCES[creature.source];
    pitchNote.textContent = src.pitchInfo ? src.pitchInfo(creature, R, n => S.noteName(n)) : (src.pitchNote || '');
  }

  // ---------- source ranges (rebuilt when the source changes) ----------
  const gSource = document.getElementById('g-source');
  function buildSource() {
    gSource.textContent = '';
    sourceControls = [];
    const part = PARTS.SOURCES[creature.source];
    document.getElementById('srcTitle').textContent = part.label;
    document.getElementById('srcDot').style.background = part.colors[0];
    groupsInto(gSource, part, sourceControls);
  }
  function groupsInto(host, part, list) {
    for (const g of part.groups) {
      const fs = el('fieldset'), lg = el('legend'), dot = el('span', 'dot');
      dot.style.background = g.c; lg.append(dot, document.createTextNode(g.name)); fs.appendChild(lg);
      const box = el('div', 'ranges'); fs.appendChild(box);
      for (const id of g.ids) list.push(rangeFor(box, part.ns + '.' + id, g.c));
      host.appendChild(fs);
    }
  }
  function rangeFor(host, key, c) {
    const s = C.BY_KEY[key];
    return kit.Range(host, {
      name: s.label, min: s.min, max: s.max, scale: s.scale, step: s.step, options: s.options, unit: s.unit, c,
      round: s.step ? 0 : (s.max - s.min) / 1000, title: s.title,
      get: () => R(key),
      set: v => {
        creature.ranges[key] = v;
        showPitchNote();
        if (pad && (key === 'tube.tongueX' || key === 'tube.tongueY')) pad.show();
        changed();
      },
    });
  }

  // ---------- body (rebuilt when the body changes) ----------
  const gBody = document.getElementById('g-body'), padBox = document.getElementById('padBox');
  pad = kit.Pad(document.getElementById('pad'), {
    get: () => ({ x: R('tube.tongueX'), y: R('tube.tongueY') }),
    set: (x, y) => { creature.ranges['tube.tongueX'] = x; creature.ranges['tube.tongueY'] = y; for (const m of bodyControls) m.show(); changed(); },
  });
  function buildBody() {
    gBody.textContent = '';
    bodyControls = [];
    const part = PARTS.BODIES[creature.body];
    document.getElementById('bodyTitle').textContent = part.ns ? part.label : 'Body';
    document.getElementById('bodyDot').style.background = part.colors[0] || 'var(--graphite)';
    groupsInto(gBody, part, bodyControls);
    padBox.hidden = part.view !== 'tube';                  // the vowel pad belongs to the tube
    document.getElementById('bodyOff').hidden = !!part.ns;
  }

  // ---------- call, signature, manner ----------
  {
    const box = document.getElementById('g-call-r'), kn = document.getElementById('g-call-k');
    const F = C.FIELD;
    const rf = (p, name, title) => {
      const f = F[p], g = path(p);
      controls.push(kit.Range(box, { name, min: f.min, max: f.max, scale: f.scale || 'lin', step: f.kind === 'irange' ? 1 : 0, unit: f.unit, c: COL.krill,
        round: f.kind === 'irange' ? 0 : 0.001, title, get: g.get, set: v => { g.set(v); changed(); } }));
    };
    rf('call.units', 'Units per call', '1 = a single cry; 8–12 = a chattering train');
    rf('call.unitLength', 'Unit length');
    rf('call.gap', 'Gap', 'Silence between units of a call');
    rf('call.rest', 'Rest', 'Silence between calls');
    rf('call.attack', 'Attack');
    rf('call.release', 'Release');
    const seg = document.getElementById('g-call-s');
    controls.push(kit.Seg(seg, { label: 'Legato', options: [[false, 'Off'], [true, 'On']], get: path('call.legato').get, set: v => { creature.call.legato = v; changed(); } }));
    controls.push(kit.Seg(seg, { label: 'Evolve', options: C.EVOLVE.map(v => [v, v.charAt(0).toUpperCase() + v.slice(1)]), get: path('call.evolve').get, set: v => { creature.call.evolve = v; changed(); } }));
    const knob = (p, name, c, title) => { const f = F[p], g = path(p); controls.push(kit.Knob(kn, { name, min: f.min, max: f.max, def: f.def, c: c || COL.krill, title, get: g.get, set: v => { g.set(+v.toFixed(3)); changed(); } })); };
    knob('call.evolveAmount', 'Evolve', null, 'How far units move across one call');
    knob('morph', 'Morph', null, 'Odds that a unit slides between two settings while it sounds');
    const sk = document.getElementById('g-sig');
    const knob2 = (host, p, name, opt) => {
      const f = F[p], g = path(p);
      controls.push(kit.Knob(host, Object.assign({ name, min: f.min, max: f.max, def: f.def, c: COL.krill, get: g.get, set: v => { g.set(+v.toFixed(3)); changed(); } }, opt || {})));
    };
    knob2(sk, 'signature.amount', 'Amount', { title: 'How often a call is its signature' });
    knob2(sk, 'signature.variation', 'Variation', { title: 'How much the signature changes each time' });
    const mk = document.getElementById('g-manner');
    knob2(mk, 'manner.talkative', 'Talkative', { title: 'How readily it starts a call (in a pond)' });
    knob2(mk, 'manner.responsive', 'Responsive', { title: 'How readily it answers (in a pond)' });
    knob2(mk, 'manner.mimicry', 'Mimicry', { title: 'Odds an answer copies what it heard' });
    knob2(mk, 'manner.pan', 'Pan', { fmt: v => Math.abs(v) < 0.005 ? 'C' : (v < 0 ? 'L ' : 'R ') + Math.round(Math.abs(v) * 100) });
    knob2(mk, 'manner.wander', 'Wander', { title: 'How far it drifts around its pan position' });
    knob2(mk, 'manner.level', 'Level', { fmt: v => (+v.toFixed(1)) + ' dB', title: 'Calibrated: 0 dB is about -20 dBFS RMS while calling, for every species' });
    const ok = document.getElementById('g-out');
    controls.push(kit.Seg(ok, { label: 'Low-pass', options: [[false, 'Off'], [true, 'On']], get: path('filter.on').get, set: v => { creature.filter.on = v; showFilter(); changed(); } }));
    const f = F['filter.cutoff'];
    controls.push(kit.Knob(ok, { name: 'Cutoff', min: f.min, max: f.max, def: f.def, scale: 'log', c: COL.krill,
      fmt: v => v >= 1000 ? (+(v / 1000).toFixed(1)) + ' kHz' : Math.round(v) + ' Hz', title: '24 dB/oct, at the end of the creature: tames noise and loud highs',
      get: path('filter.cutoff').get, set: v => { creature.filter.cutoff = Math.round(v); changed(); } }));
  }
  function showFilter() { document.getElementById('g-out').classList.toggle('off', !creature.filter.on); }
  document.getElementById('sigRoll').addEventListener('click', () => { creature.seed = randomSeed(); changed(); showSeed(); run('signature'); });
  const showSeed = () => { document.getElementById('sigSeed').textContent = 'Seed ' + creature.seed; };

  function refreshAll() {
    showName(); showMark();
    for (const c of controls) c.show();
    for (const c of sourceControls) c.show();
    for (const c of bodyControls) c.show();
    if (PARTS.BODIES[creature.body].view === 'tube') pad.show();
    showPitchNote(); showSeed(); showFilter();
  }

  // ---------- preview key ----------
  {
    const box = document.getElementById('keyBox');
    const rootSel = document.getElementById('root'), scaleSel = document.getElementById('scale');
    for (const r of S.ROOTS) rootSel.appendChild(new Option(r, r));
    for (const s in S.SCALES) scaleSel.appendChild(new Option(s, s));
    try { const p = JSON.parse(localStorage.getItem(STORE_PITCH)); if (p && p.mode) previewPitch = p; } catch (e) { /* default */ }
    const keySeg = kit.Seg(box, { options: [['key', 'In key'], ['free', 'Free']], get: () => previewPitch.mode, set: v => { previewPitch.mode = v; sync(); } });
    box.appendChild(rootSel); box.appendChild(scaleSel);
    function sync() {
      rootSel.disabled = scaleSel.disabled = previewPitch.mode !== 'key';
      rootSel.value = previewPitch.root || 'D'; scaleSel.value = previewPitch.scale || 'minor';
      keySeg.show(); showPitchNote();
      try { localStorage.setItem(STORE_PITCH, JSON.stringify(previewPitch)); } catch (e) { /* ignore */ }
    }
    rootSel.addEventListener('change', () => { previewPitch.root = rootSel.value; sync(); });
    scaleSel.addEventListener('change', () => { previewPitch.scale = scaleSel.value; sync(); });
    sync();
  }

  // ---------- worker ----------
  const worker = new Worker(URL.createObjectURL(new Blob([document.getElementById('worker-src').textContent], { type: 'text/javascript' })));
  let jobId = 0;
  const jobs = {};
  worker.onmessage = e => {
    const m = e.data, j = jobs[m.id];
    if (!j) return;
    if (m.type === 'progress') { if (j.progress) j.progress(m.p); return; }
    delete jobs[m.id];
    if (m.type === 'error') j.reject(new Error(m.message)); else j.resolve(m.result);
  };
  worker.onerror = e => setStatus('Render worker failed: ' + (e.message || 'unknown error'), true);
  function job(msg, progress) {
    return new Promise((resolve, reject) => { const id = ++jobId; jobs[id] = { resolve, reject, progress }; worker.postMessage(Object.assign({ id }, msg)); });
  }

  // ---------- status ----------
  const statusEl = document.getElementById('status');
  function setStatus(t, err) { statusEl.textContent = t; statusEl.classList.toggle('err', !!err); }

  // ---------- audio ----------
  let ctx = null, playing = null;
  function audio() {
    if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) ctx = new AC({ sampleRate: SR }); }
    if (ctx && ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function stop() { if (playing) { try { playing.src.stop(); } catch (e) { /* already stopped */ } playing = null; } }
  function play(res) {
    stop();
    const a = audio();
    if (!a) return;
    const buf = a.createBuffer(2, res.L.length, SR);
    buf.copyToChannel(res.L, 0); buf.copyToChannel(res.R, 1);
    const src = a.createBufferSource(); src.buffer = buf; src.connect(a.destination);
    const t0 = a.currentTime + 0.03;
    src.start(t0);
    playing = { src, t0, res };
    src.onended = () => { if (playing && playing.src === src) { playing = null; drawTop(-1); drawTube(-1); } };
    loop();
  }
  function loop() {
    if (!playing) return;
    const t = ctx.currentTime - playing.t0;
    drawTop(t); drawTube(t);
    requestAnimationFrame(loop);
  }

  // ---------- render buttons ----------
  const callBtn = document.getElementById('call'), sigBtn = document.getElementById('sig'), soloBtn = document.getElementById('solo');
  let busy = false;
  async function run(kind) {
    if (busy) return;
    busy = true; callBtn.disabled = sigBtn.disabled = true;
    audio();                                     // unlock audio inside the click
    const s = kind === 'call' ? seed++ : seed;
    setStatus('Rendering ' + (kind === 'call' ? 'a call' : 'the signature') + '…');
    const t = performance.now();
    try {
      const res = await job({ type: kind, creature, pitch: previewPitch, seed: s });
      res.seed = s;
      last = res;
      drawSpec(); drawTop(-1); drawTube(-1); showReadouts();
      play(res);
      setStatus((res.call.kind === 'signature' ? 'Signature' : res.call.kind === 'copy' ? 'Copy' : 'Fresh call') + ' · rendered in ' + Math.round(performance.now() - t) + ' ms');
    } catch (e) { setStatus('Could not render: ' + e.message, true); }
    busy = false; callBtn.disabled = sigBtn.disabled = false;
  }
  callBtn.addEventListener('click', () => run('call'));
  sigBtn.addEventListener('click', () => run('signature'));
  const prog = document.getElementById('prog'), progBar = prog.firstChild;
  soloBtn.addEventListener('click', async () => {
    if (soloBtn.disabled) return;
    soloBtn.disabled = true; prog.style.display = 'block'; progBar.style.width = '0';
    setStatus('Rendering 60 s solo…');
    const s = (randomSeed() % 99999) + 1;
    try {
      const r = await job({ type: 'solo', creature, pitch: previewPitch, seed: s, seconds: 60, bits: 24 }, p => { progBar.style.width = (p * 100) + '%'; });
      download(new Blob([r.bytes], { type: 'audio/wav' }), r.fileName);
      setStatus('Saved ' + r.fileName + ' · ' + r.calls + ' calls · seed ' + s);
    } catch (e) { setStatus('Could not render: ' + e.message, true); }
    soloBtn.disabled = false; prog.style.display = 'none';
  });

  // ---------- files ----------
  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  document.getElementById('save').addEventListener('click', () => {
    download(new Blob([C.serialise(creature)], { type: 'application/json' }), C.fileName(creature));
    dirty = false; showName(); setStatus('Saved ' + C.fileName(creature));
  });
  const fileIn = document.getElementById('file');
  document.getElementById('load').addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', () => { if (fileIn.files[0]) readFile(fileIn.files[0]); fileIn.value = ''; });
  function readFile(f) {
    f.text().then(txt => {
      try {
        const w = load(txt);
        dirty = false; showName();
        setStatus('Loaded ' + f.name + (w.length ? ' · ' + w.length + ' fixed: ' + w.join('; ') : ''), w.length > 0);
      } catch (e) { setStatus(f.name + ' is not a creature file: ' + e.message, true); }
    });
  }
  document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dropping'); });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  document.addEventListener('drop', e => { e.preventDefault(); document.body.classList.remove('dropping'); const f = e.dataTransfer.files[0]; if (f) readFile(f); });
  // examples and new
  const exMenu = document.getElementById('exMenu');
  for (const ex of (window.KRILL_EXAMPLES || [])) {
    const b = el('button', 'it'); b.type = 'button';
    b.append(document.createTextNode(ex.name), el('small', null, C.speciesLabel(C.normalise(ex).creature)));
    b.addEventListener('click', () => { exMenu.hidden = true; load(ex); dirty = false; showName(); setStatus('Example ' + ex.name + ' loaded'); });
    exMenu.appendChild(b);
  }
  document.getElementById('examples').addEventListener('click', e => { e.stopPropagation(); exMenu.hidden = !exMenu.hidden; });
  document.addEventListener('click', e => { if (!exMenu.contains(e.target)) exMenu.hidden = true; });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') exMenu.hidden = true; });
  document.getElementById('new').addEventListener('click', () => {
    const c = C.defaults(creature.source, creature.body, { name: C.randomName(new Rng(randomSeed())), seed: randomSeed() % 100000 });
    load(c); dirty = true; showName(); setStatus('New ' + C.speciesLabel(creature) + ' creature');
  });
  // space bar plays a call when no control has focus
  document.addEventListener('keydown', e => {
    if (e.code === 'Space' && (document.activeElement === document.body || !document.activeElement)) { e.preventDefault(); run('call'); }
  });

  // ---------- LCD ----------
  let last = null;
  const specC = document.getElementById('spec'), topC = document.getElementById('specTop'), tubeC = document.getElementById('tube');
  const LUT = (() => {           // dark → purple → orange → pale yellow
    const stops = [[0, [6, 6, 8]], [0.3, [60, 15, 90]], [0.55, [150, 40, 120]], [0.8, [240, 120, 50]], [1, [255, 240, 170]]];
    const t = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const x = i / 255; let k = 0; while (k < stops.length - 2 && x > stops[k + 1][0]) k++;
      const [a, ca] = stops[k], [b, cb] = stops[k + 1], f = (x - a) / (b - a);
      for (let c = 0; c < 3; c++) t[i * 3 + c] = ca[c] + (cb[c] - ca[c]) * f;
    }
    return t;
  })();
  function fit(c) {
    const r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    return c.getContext('2d');
  }
  let specImg = null;
  function drawSpec() {
    const g = fit(specC), W = specC.width, H = specC.height;
    g.fillStyle = '#060608'; g.fillRect(0, 0, W, H);
    if (!last) {
      g.fillStyle = '#8f8'; g.globalAlpha = 0.5; g.font = (11 * (window.devicePixelRatio || 1)) + 'px Monaco, monospace';
      g.fillText('PRESS CALL OR SPACE', 12 * (window.devicePixelRatio || 1), H / 2); g.globalAlpha = 1; return;
    }
    const sp = last.spec;
    if (!specImg || specImg.src !== sp) {
      const img = new ImageData(sp.cols, sp.bins);
      for (let c = 0; c < sp.cols; c++) for (let k = 0; k < sp.bins; k++) {
        const v = sp.data[c * sp.bins + k], o = ((sp.bins - 1 - k) * sp.cols + c) * 4;
        img.data[o] = LUT[v * 3]; img.data[o + 1] = LUT[v * 3 + 1]; img.data[o + 2] = LUT[v * 3 + 2]; img.data[o + 3] = 255;
      }
      const off = document.createElement('canvas'); off.width = sp.cols; off.height = sp.bins;
      off.getContext('2d').putImageData(img, 0, 0);
      specImg = { src: sp, canvas: off };
    }
    const bottom = Math.round(H * 0.84);
    g.imageSmoothingEnabled = true;
    g.drawImage(specImg.canvas, 0, 0, W, bottom);
    // unit lanes and time ticks
    const d = window.devicePixelRatio || 1, secs = last.seconds, x = t => t / secs * W;
    g.font = (9.5 * d) + 'px Monaco, monospace'; g.textBaseline = 'middle';
    for (const u of last.call.units) {
      g.fillStyle = 'rgba(136,255,136,.55)';
      g.fillRect(x(u.t), bottom + 4 * d, Math.max(1, x(u.t + u.dur) - x(u.t)), 5 * d);
    }
    g.fillStyle = 'rgba(136,255,136,.7)';
    for (let s = 1; s < secs; s++) { g.fillRect(x(s), H - 9 * d, 1, 5 * d); }
    const free = last.pitch === 'FREE';
    g.fillStyle = '#8f8';
    let lastX = -1e9;
    for (const u of last.call.units) {
      const px = x(u.t);
      if (px - lastX < 46 * d) continue;
      g.fillText(S.noteName(u.note, free), px, bottom + 16 * d); lastX = px;
    }
    g.fillStyle = 'rgba(136,255,136,.6)';
    g.fillText(Math.round(last.spec.fmax / 1000) + ' kHz', W - 48 * d, 10 * d);
  }
  function drawTop(t) {
    const g = fit(topC), W = topC.width, H = topC.height;
    g.clearRect(0, 0, W, H);
    if (!last || t < 0) return;
    const px = t / last.seconds * W;
    g.fillStyle = '#fff'; g.shadowColor = '#fff'; g.shadowBlur = 8; g.fillRect(px, 0, 2, H); g.shadowBlur = 0;
  }
  // the tube view: the tract shape of the unit sounding (or the first unit when stopped)
  const N_ORAL = 40, VELUM = 16, dBuf = new Float64Array(N_ORAL);
  let tubeKey = '';
  function unitAt(t) {
    const us = last.call.units;
    let i = 0; while (i + 1 < us.length && us[i + 1].t <= t) i++;
    const u = us[i], f = Math.max(0, Math.min(1, (t - u.t) / u.dur));
    return { u, i, f };
  }
  function drawTube(t) {
    const lbl = document.getElementById('tubeLbl');
    const g = fit(tubeC), W = tubeC.width, H = tubeC.height, d = window.devicePixelRatio || 1;
    if (!last) { g.fillStyle = '#060608'; g.fillRect(0, 0, W, H); lbl.textContent = PARTS.BODIES[creature.body].view === 'tube' ? 'TUBE' : 'PITCH'; return; }
    const { u, i, f } = unitAt(t < 0 ? 0 : t);
    if (last.call.bodyView !== 'tube') { drawPitch(g, W, H, d, t); lbl.textContent = 'PITCH'; return; }
    const key = i + ':' + Math.round(f * 60) + ':' + W;
    if (key === tubeKey) return;                 // nothing changed since the last frame
    tubeKey = key;
    lbl.textContent = 'TUBE';
    const a = u.body.start, b = u.body.end, s = {};
    for (const k in a) s[k] = a[k] + (b[k] - a[k]) * f;
    s.spread = 0;
    const nasal = window.MouthTube.shape(s, dBuf, 0);
    g.fillStyle = '#060608'; g.fillRect(0, 0, W, H);
    const x0 = 16 * d, x1 = W - 16 * d, mid = H * 0.58, sc = H * 0.11;
    const w = (x1 - x0) / N_ORAL;
    g.fillStyle = 'rgba(150,61,151,.9)';
    for (let k = 0; k < N_ORAL; k++) { const h = Math.max(1, dBuf[k] * sc); g.fillRect(x0 + k * w, mid - h / 2, Math.max(1, w - 1), h); }
    // nose branch
    if (nasal > 0) {
      g.strokeStyle = 'rgba(150,61,151,.9)'; g.lineWidth = Math.max(1, Math.sqrt(nasal) * 6 * d);
      g.beginPath(); g.moveTo(x0 + VELUM * w, mid - dBuf[VELUM] * sc / 2); g.lineTo(x0 + VELUM * w + 20 * d, mid - 2.4 * sc); g.lineTo(x1, mid - 2.4 * sc); g.stroke();
    }
    g.fillStyle = '#8f8'; g.font = (9.5 * d) + 'px Monaco, monospace'; g.textBaseline = 'alphabetic';
    g.fillText('GLOTTIS', x0, H - 8 * d);
    g.fillText('LIPS', x1 - 26 * d, H - 8 * d);
    g.fillText(s.length.toFixed(1) + ' CM · UNIT ' + (i + 1) + '/' + last.call.units.length, x0 + 70 * d, H - 8 * d);
    // tongue positions of every unit on the pad
    if (t < 0 && PARTS.BODIES[creature.body].view === 'tube') pad.showPoints(last.call.units.map(v => ({ x: v.body.start.tongueX, y: v.body.start.tongueY })));
  }
  function drawPitch(g, W, H, d, t) {
    const key = 'p:' + W + ':' + (t < 0 ? -1 : Math.round(t * 30));
    if (key === tubeKey) return;
    tubeKey = key;
    g.fillStyle = '#060608'; g.fillRect(0, 0, W, H);
    const us = last.call.units, secs = last.seconds;
    let lo = Infinity, hi = -Infinity;
    for (const u of us) { lo = Math.min(lo, u.note, u.noteEnd); hi = Math.max(hi, u.note, u.noteEnd); }
    lo -= 2; hi += 2;
    const x = tt => 12 * d + tt / secs * (W - 24 * d), y = n => H - 22 * d - (n - lo) / (hi - lo) * (H - 44 * d);
    g.strokeStyle = 'rgba(136,255,136,.9)'; g.lineWidth = 2 * d;
    for (const u of us) {
      g.beginPath();
      for (let k = 0; k <= 20; k++) { const f = k / 20, sm = f * f * (3 - 2 * f), n = u.note + (u.noteEnd - u.note) * sm; const px = x(u.t + u.dur * f), py = y(n); if (k) g.lineTo(px, py); else g.moveTo(px, py); }
      g.stroke();
    }
    if (t >= 0) { g.fillStyle = '#fff'; g.fillRect(x(t), 0, 2, H); }
    g.fillStyle = '#8f8'; g.font = (9.5 * d) + 'px Monaco, monospace';
    g.fillText(S.noteName(hi - 2) + ' ', 12 * d, 14 * d); g.fillText(S.noteName(lo + 2), 12 * d, H - 8 * d);
    g.fillText('SOURCE PITCH', 60 * d, H - 8 * d);
  }
  function showReadouts() {
    const ro = document.getElementById('ro'); ro.textContent = '';
    if (!last) return;
    const c = last.call, n = c.units.length;
    const add = (b, v) => { const s = el('span'); s.append(el('b', null, b), document.createTextNode(v)); ro.appendChild(s); };
    add('CALL', c.kind.toUpperCase());
    add('UNITS', String(n));
    add('LEN', (c.end - c.t).toFixed(1) + ' S');
    add('KEY', last.pitch);
    add('SEED', String(last.seed));
    add('PEAK', isFinite(last.peakDb) ? last.peakDb.toFixed(1) + ' DB' : '—');
  }
  const ro2 = new ResizeObserver(() => { tubeKey = ''; drawSpec(); drawTop(-1); drawTube(-1); });
  ro2.observe(specC); ro2.observe(tubeC);

  // ---------- start ----------
  let start = null;
  try { start = JSON.parse(localStorage.getItem(STORE)); } catch (e) { start = null; }
  if (!start) start = (window.KRILL_EXAMPLES || [])[0] || C.defaults('dolphin', 'none', { name: 'Unnamed' });
  try { load(start); } catch (e) { load(C.defaults('throat', 'none')); }
  dirty = false; showName();
  drawSpec(); drawTube(-1);
  window.krillPage = { get creature() { return creature; }, load, run, get last() { return last; } };   // for tests
})();
