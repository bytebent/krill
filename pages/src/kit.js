/*
 * krill · page kit: knobs, range sliders, segmented buttons and the vowel-pad region.
 * Same look and handling as the bytebent plugin UIs: drag, Shift for fine, double-click,
 * mouse wheel, arrow keys; every control is focusable and announces its value.
 */
(function (root) {
  'use strict';
  const K = root.Krill = root.Krill || {};
  const C = K.creature;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

  // ---------- formatting ----------
  // short number: 2 decimals below 10, 1 below 100, none above; trailing zeros dropped
  function num(v, d) {
    const a = Math.abs(v);
    if (d == null) d = a >= 100 ? 0 : a >= 10 ? 1 : 2;
    return String(+v.toFixed(d));
  }
  function fmtFor(spec) {
    if (spec.options) return v => spec.options[Math.round(v)] || num(v);
    if (spec.fmt) return spec.fmt;
    const u = spec.unit;
    if (u === 's') return v => v < 1 ? Math.round(v * 1000) + ' ms' : num(v) + ' s';
    if (u === 'ms') return v => num(v) + ' ms';
    if (u === 'dB') return v => num(v, 1) + ' dB';
    if (u === 'cm') return v => num(v, 1) + ' cm';
    if (u === 'st') return v => (v > 0 ? '+' : '') + num(v, spec.step ? 0 : 1) + ' st';
    if (u === 'oct') return v => (v > 0 ? '+' : '') + num(v) + ' oct';
    if (u === '/s') return v => num(v) + '/s';
    if (spec.step) return v => String(Math.round(v));
    if (spec.min === 0 && spec.max === 1) return v => Math.round(v * 100) + '%';
    return v => num(v);
  }

  // ---------- knob (single value) ----------
  // s: { name, min, max, scale ('lin'|'log'), def, fmt, c (colour), get(), set(v), title }
  function Knob(host, s) {
    const wrap = el('div', 'knob');
    const dial = el('div', 'dial'); dial.tabIndex = 0; dial.setAttribute('role', 'slider'); dial.setAttribute('aria-label', s.name);
    dial.appendChild(el('div', 'cap')); const ptr = el('div', 'ptr'); dial.appendChild(ptr);
    const valEl = el('span', 'val');
    wrap.append(dial, el('span', 'name', s.name), valEl);
    if (s.title) wrap.title = s.title;
    if (s.c) dial.style.setProperty('--c', s.c);
    host.appendChild(wrap);
    const lg = s.scale === 'log';
    const toN = v => lg ? Math.log(v / s.min) / Math.log(s.max / s.min) : (v - s.min) / (s.max - s.min);
    const fromN = n => { n = clamp01(n); const v = lg ? s.min * Math.pow(s.max / s.min, n) : s.min + (s.max - s.min) * n; return s.step ? Math.round(v / s.step) * s.step : v; };
    const fmt = s.fmt || fmtFor(s);
    const bip = s.min < 0 && s.max > 0;
    function show() {
      const v = s.get(), n = clamp01(toN(v));
      const z = bip ? clamp01(toN(0)) : 0;
      dial.style.setProperty('--a0', (Math.min(z, n) * 270) + 'deg');
      dial.style.setProperty('--a1', (Math.max(z, n) * 270) + 'deg');
      ptr.style.transform = 'rotate(' + (-135 + n * 270) + 'deg)';
      const t = fmt(v);
      valEl.textContent = t;
      dial.setAttribute('aria-valuetext', t);
    }
    function setN(n, done) { const v = fromN(n); if (v !== s.get()) { s.set(v); show(); } if (done && s.done) s.done(); }
    let y0 = null, n0 = 0;
    dial.addEventListener('pointerdown', e => { dial.setPointerCapture(e.pointerId); y0 = e.clientY; n0 = clamp01(toN(s.get())); dial.focus(); e.preventDefault(); });
    dial.addEventListener('pointermove', e => {
      if (y0 === null) return;
      setN(n0 + (y0 - e.clientY) * (e.shiftKey ? 0.0008 : 0.005));
      if (e.shiftKey) { y0 = e.clientY; n0 = clamp01(toN(s.get())); }
    });
    const end = () => { if (y0 !== null) { y0 = null; if (s.done) s.done(); } };
    dial.addEventListener('pointerup', end); dial.addEventListener('pointercancel', end);
    dial.addEventListener('dblclick', () => setN(toN(s.def), true));
    dial.addEventListener('wheel', e => { e.preventDefault(); setN(toN(s.get()) - Math.sign(e.deltaY) * (e.shiftKey ? 0.005 : 0.03), true); }, { passive: false });
    dial.addEventListener('keydown', e => {
      const st = e.shiftKey ? 0.005 : 0.02, n = clamp01(toN(s.get()));
      const k = { ArrowUp: n + st, ArrowRight: n + st, ArrowDown: n - st, ArrowLeft: n - st, Home: 0, End: 1 }[e.key];
      if (k !== undefined) { e.preventDefault(); setN(k, true); }
    });
    show();
    return { show, el: wrap };
  }

  // ---------- range slider (two handles; locked when min = max) ----------
  // s: { name, min, max, scale ('lin'|'log'|'sq'), step, options, unit, fmt, c, get() → [lo, hi], set([lo, hi]), done() }
  function Range(host, s) {
    const row = el('div', 'rng');
    const track = el('div', 'track'), fill = el('div', 'fill');
    const hLo = el('div', 'h lo'), hHi = el('div', 'h hi');
    for (const h of [hLo, hHi]) { h.tabIndex = 0; h.setAttribute('role', 'slider'); }
    hLo.setAttribute('aria-label', s.name + ' minimum'); hHi.setAttribute('aria-label', s.name + ' maximum');
    track.append(fill, hLo, hHi);
    const valEl = el('span', 'val');
    row.append(el('span', 'rname', s.name), track, valEl);
    if (s.title) row.title = s.title;
    if (s.c) { track.style.setProperty('--c', s.c); row.style.setProperty('--c', s.c); }
    host.appendChild(row);
    const scale = s.scale || 'lin', step = s.step ? 1 : 0;
    const fmt = s.fmt || fmtFor(s);
    const pos = v => C.positionOf(scale, s.min, s.max, v);
    const val = p => {
      let v = C.valueAt(scale, step, s.min, s.max, clamp01(p));
      if (!step && s.round) v = Math.round(v / s.round) * s.round;
      return v;
    };
    if (step && s.max - s.min <= 16) for (let v = s.min; v <= s.max; v++) {
      const t = el('span', 'tk'); t.style.left = (pos(v) * 100) + '%'; track.appendChild(t);
    }
    function show() {
      const [lo, hi] = s.get(), a = pos(lo), b = pos(hi);
      hLo.style.left = (a * 100) + '%'; hHi.style.left = (b * 100) + '%';
      fill.style.left = (a * 100) + '%'; fill.style.width = ((b - a) * 100) + '%';
      const locked = lo === hi;
      row.classList.toggle('locked', locked);
      const t = locked ? fmt(lo) : fmt(lo) + ' – ' + fmt(hi);
      valEl.textContent = t;
      hLo.setAttribute('aria-valuetext', fmt(lo) + (locked ? ', locked' : ''));
      hHi.setAttribute('aria-valuetext', fmt(hi));
      row.title = (s.title ? s.title + '\n' : '') + 'Double-click to ' + (locked ? 'unlock' : 'lock');
    }
    function put(lo, hi, done) {
      if (lo > hi) { const t = lo; lo = hi; hi = t; }
      const [a, b] = s.get();
      if (lo !== a || hi !== b) { s.set([lo, hi]); show(); }
      if (done && s.done) s.done();
    }
    const pAt = e => { const r = track.getBoundingClientRect(); return clamp01((e.clientX - r.left) / r.width); };
    let drag = null;
    function begin(e, mode) {
      const [lo, hi] = s.get();
      drag = { mode, p0: pAt(e), a: pos(lo), b: pos(hi) };
      track.setPointerCapture(e.pointerId);
      e.preventDefault(); e.stopPropagation();
    }
    hLo.addEventListener('pointerdown', e => { hLo.focus(); begin(e, row.classList.contains('locked') ? 'split' : 'lo'); });
    hHi.addEventListener('pointerdown', e => { hHi.focus(); begin(e, 'hi'); });
    fill.addEventListener('pointerdown', e => begin(e, row.classList.contains('locked') ? 'split' : 'both'));
    track.addEventListener('pointerdown', e => {
      const p = pAt(e), [lo, hi] = s.get(), a = pos(lo), b = pos(hi);
      const which = Math.abs(p - a) <= Math.abs(p - b) ? 'lo' : 'hi';
      if (which === 'lo') put(val(p), hi); else put(lo, val(p));
      begin(e, which);
    });
    track.addEventListener('pointermove', e => {
      if (!drag) return;
      const p = pAt(e), d = p - drag.p0;
      const [lo, hi] = s.get();
      if (drag.mode === 'split') {                    // pulling a locked handle opens the range
        if (Math.abs(d) < 0.01) return;
        drag.mode = d < 0 ? 'lo' : 'hi';
      }
      if (drag.mode === 'lo') put(Math.min(val(drag.a + d), hi), hi);
      else if (drag.mode === 'hi') put(lo, Math.max(val(drag.b + d), lo));
      else {
        const w = drag.b - drag.a, a = clamp01(Math.min(drag.a + d, 1 - w));
        put(val(a), val(a + w));
      }
    });
    const end = () => { if (drag) { drag = null; if (s.done) s.done(); } };
    track.addEventListener('pointerup', end); track.addEventListener('pointercancel', end);
    row.addEventListener('dblclick', () => {
      const [lo, hi] = s.get();
      if (lo === hi) { const p = pos(lo); put(val(Math.max(0, p - 0.1)), val(Math.min(1, p + 0.1)), true); }
      else { const m = val((pos(lo) + pos(hi)) / 2); put(m, m, true); }
    });
    for (const h of [hLo, hHi]) h.addEventListener('keydown', e => {
      const isLo = h === hLo, [lo, hi] = s.get();
      const v = isLo ? lo : hi, p = pos(v);
      let nv = null;
      const stepP = step ? null : (e.shiftKey ? 0.002 : 0.01);
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') nv = step ? Math.min(s.max, v + 1) : val(p + stepP);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') nv = step ? Math.max(s.min, v - 1) : val(p - stepP);
      else if (e.key === 'PageUp') nv = val(p + 0.1);
      else if (e.key === 'PageDown') nv = val(p - 0.1);
      else if (e.key === 'Home') nv = s.min;
      else if (e.key === 'End') nv = s.max;
      else if (e.key === 'Enter') { row.dispatchEvent(new Event('dblclick')); e.preventDefault(); return; }
      if (nv === null) return;
      e.preventDefault();
      if (row.classList.contains('locked')) put(nv, nv, true);
      else if (isLo) put(Math.min(nv, hi), hi, true); else put(lo, Math.max(nv, lo), true);
    });
    show();
    return { show, el: row };
  }

  // ---------- segmented buttons ----------
  // s: { options: [[value, label]...], get(), set(v), label }
  function Seg(host, s) {
    const wrap = el('div', 'segwrap');
    if (s.label) wrap.appendChild(el('span', null, s.label));
    const seg = el('div', 'seg'); seg.setAttribute('role', 'group'); if (s.label) seg.setAttribute('aria-label', s.label);
    const btns = s.options.map(([v, label]) => {
      const b = el('button', null, label); b.type = 'button';
      b.addEventListener('click', () => { if (s.get() !== v) { s.set(v); show(); if (s.done) s.done(); } });
      seg.appendChild(b); return [v, b];
    });
    wrap.appendChild(seg);
    host.appendChild(wrap);
    function show() { const cur = s.get(); for (const [v, b] of btns) b.setAttribute('aria-pressed', String(v === cur)); }
    show();
    return { show, el: wrap };
  }

  // ---------- vowel pad with a region ----------
  // s: { get() → { x: [lo, hi], y: [lo, hi] }, set(x, y), done() }. X 0 front … 1 back, Y 0 close … 1 open.
  function Pad(svg, s) {
    const ns = 'http://www.w3.org/2000/svg';
    const PT = 26, PB = 168, PL = 30, PR = 258, PBL = PL + (PR - PL) * 0.5;
    const leftAt = Y => PL + (PBL - PL) * Y;
    const toXY = (X, Y) => [leftAt(Y) + X * (PR - leftAt(Y)), PT + Y * (PB - PT)];
    svg.setAttribute('viewBox', '0 0 280 186');
    const add = (tag, attrs, text, parent) => { const e = document.createElementNS(ns, tag); for (const a in attrs) e.setAttribute(a, attrs[a]); if (text) e.textContent = text; (parent || svg).appendChild(e); return e; };
    const pts = [toXY(0, 0), toXY(1, 0), toXY(1, 1), toXY(0, 1)];
    add('polygon', { class: 'face', points: pts.map(p => p.join(',')).join(' ') });
    for (const y of [1 / 3, 2 / 3]) { const a = toXY(0, y), b = toXY(1, y); add('line', { class: 'grid', x1: a[0], y1: a[1], x2: b[0], y2: b[1] }); }
    { const a = toXY(0.5, 0), b = toXY(0.5, 1); add('line', { class: 'grid', x1: a[0], y1: a[1], x2: b[0], y2: b[1] }); }
    const V = [
      [0, 0, 'i', 'y'], [0.5, 0, 'ɨ', 'ʉ'], [1, 0, 'ɯ', 'u'],
      [0.24, 0.15, 'ɪ', 'ʏ'], [0.78, 0.15, '', 'ʊ'],
      [0, 1 / 3, 'e', 'ø'], [0.5, 1 / 3, 'ɘ', 'ɵ'], [1, 1 / 3, 'ɤ', 'o'],
      [0.5, 0.5, 'ə', ''],
      [0, 2 / 3, 'ɛ', 'œ'], [0.5, 2 / 3, 'ɜ', 'ɞ'], [1, 2 / 3, 'ʌ', 'ɔ'],
      [0.02, 0.84, 'æ', ''], [0.5, 0.84, 'ɐ', ''],
      [0, 1, 'a', 'ɶ'], [1, 1, 'ɑ', 'ɒ'],
    ];
    for (const [x, y, u, r] of V) {
      const [px, py] = toXY(x, y);
      if (u && r) { add('text', { class: 'v', x: px - 8, y: py }, u); add('text', { class: 'v', x: px + 8, y: py }, r); }
      else if (u) add('text', { class: 'v', x: px, y: py }, u);
      else add('text', { class: 'v', x: px + 8, y: py }, r);
    }
    add('text', { class: 'ax', x: PL + 8, y: 12 }, 'FRONT');
    add('text', { class: 'ax', x: (PL + PR) / 2, y: 12 }, 'CENTRAL');
    add('text', { class: 'ax', x: PR - 6, y: 12 }, 'BACK');
    add('text', { class: 'ax', x: (PL + PR) / 2 + 30, y: 182 }, 'OPEN');
    add('text', { class: 'ax', x: 14, y: PT + 2, transform: 'rotate(-90 14 ' + (PT + 2) + ')', 'text-anchor': 'end' }, 'CLOSE');
    const ptsG = add('g', {});
    const region = add('polygon', { class: 'region' });
    const corners = [0, 1, 2, 3].map(i => add('circle', { class: 'corner', r: 4.5, 'data-i': i }));
    svg.tabIndex = 0;
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', 'Tongue region on the vowel chart. Drag to move, drag a corner to resize, drag outside to draw a new one, double-click to lock. Arrow keys move it.');

    function show() {
      const { x, y } = s.get();
      const q = [toXY(x[0], y[0]), toXY(x[1], y[0]), toXY(x[1], y[1]), toXY(x[0], y[1])];
      region.setAttribute('points', q.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' '));
      q.forEach((p, i) => { corners[i].setAttribute('cx', p[0]); corners[i].setAttribute('cy', p[1]); });
      const locked = x[0] === x[1] && y[0] === y[1];
      corners.forEach((c, i) => c.style.display = locked && i ? 'none' : '');
      corners[0].setAttribute('r', locked ? 6 : 4.5);
    }
    function showPoints(list) {               // tongue positions of the last call's units
      while (ptsG.firstChild) ptsG.removeChild(ptsG.firstChild);
      for (const p of list || []) { const [px, py] = toXY(p.x, p.y); add('circle', { class: 'pt', cx: px, cy: py, r: 2.6 }, null, ptsG); }
    }
    function chart(e) {
      const r = svg.getBoundingClientRect();
      const sx = (e.clientX - r.left) / r.width * 280, sy = (e.clientY - r.top) / r.height * 186;
      const Y = clamp01((sy - PT) / (PB - PT)), l = leftAt(Y);
      return [clamp01((sx - l) / (PR - l)), Y];
    }
    const r3 = v => Math.round(v * 1000) / 1000;
    let drag = null;
    svg.addEventListener('pointerdown', e => {
      svg.setPointerCapture(e.pointerId); svg.focus(); e.preventDefault();
      const [X, Y] = chart(e), { x, y } = s.get();
      const ci = e.target.getAttribute && e.target.getAttribute('data-i');
      if (ci !== null && ci !== undefined && e.target.classList.contains('corner')) {
        const i = +ci;      // corner i: 0 (x0,y0) 1 (x1,y0) 2 (x1,y1) 3 (x0,y1); the opposite corner stays
        drag = { mode: 'draw', ax: i === 1 || i === 2 ? x[0] : x[1], ay: i >= 2 ? y[0] : y[1] };
      } else if (e.target === region) drag = { mode: 'move', X, Y, x: x.slice(), y: y.slice() };
      else { drag = { mode: 'draw', ax: X, ay: Y }; s.set([r3(X), r3(X)], [r3(Y), r3(Y)]); show(); }
    });
    svg.addEventListener('pointermove', e => {
      if (!drag) return;
      const [X, Y] = chart(e);
      if (drag.mode === 'draw') s.set([r3(Math.min(drag.ax, X)), r3(Math.max(drag.ax, X))], [r3(Math.min(drag.ay, Y)), r3(Math.max(drag.ay, Y))]);
      else {
        const w = drag.x[1] - drag.x[0], h = drag.y[1] - drag.y[0];
        const x0 = Math.min(1 - w, Math.max(0, drag.x[0] + X - drag.X)), y0 = Math.min(1 - h, Math.max(0, drag.y[0] + Y - drag.Y));
        s.set([r3(x0), r3(x0 + w)], [r3(y0), r3(y0 + h)]);
      }
      show();
    });
    const end = () => { if (drag) { drag = null; if (s.done) s.done(); } };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
    svg.addEventListener('dblclick', e => {
      const { x, y } = s.get();
      if (x[0] === x[1] && y[0] === y[1]) s.set([r3(Math.max(0, x[0] - 0.1)), r3(Math.min(1, x[0] + 0.1))], [r3(Math.max(0, y[0] - 0.1)), r3(Math.min(1, y[0] + 0.1))]);
      else { const mx = r3((x[0] + x[1]) / 2), my = r3((y[0] + y[1]) / 2); s.set([mx, mx], [my, my]); }
      show(); if (s.done) s.done();
    });
    svg.addEventListener('keydown', e => {
      const st = e.shiftKey ? 0.005 : 0.03, { x, y } = s.get();
      const d = { ArrowLeft: [-st, 0], ArrowRight: [st, 0], ArrowUp: [0, -st], ArrowDown: [0, st] }[e.key];
      if (!d) return;
      e.preventDefault();
      const w = x[1] - x[0], h = y[1] - y[0];
      const x0 = Math.min(1 - w, Math.max(0, x[0] + d[0])), y0 = Math.min(1 - h, Math.max(0, y[0] + d[1]));
      s.set([r3(x0), r3(x0 + w)], [r3(y0), r3(y0 + h)]); show(); if (s.done) s.done();
    });
    show();
    return { show, showPoints };
  }

  K.kit = { el, Knob, Range, Seg, Pad, fmtFor, num };
})(typeof self !== 'undefined' ? self : this);
