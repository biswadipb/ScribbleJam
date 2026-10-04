const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const $ = (s) => document.querySelector(s);
const API = (window.SJ_API || '').replace(/\/$/, ''); // '' = same server as this page

// Canvas presets (max side 1024). 'square' is the standard size.
const PRESETS = { square: [1024, 1024], portrait: [768, 1024], landscape: [1024, 768], wide: [1024, 576], story: [576, 1024] };
let sizeKey = 'square';
let [W, H] = PRESETS.square;

const cv = $('#cv');            // the composite of all layers (also what gets exported)
const ctx = cv.getContext('2d', { willReadFrequently: true });
const ov = $('#ov');            // previews: selection outline, shapes being dragged
const octx = ov.getContext('2d');

// ---------- session ----------
// start_param looks like "t_<token>" (together) or "s_<token>" (alone).
// For local testing outside Telegram: /?p=t_abc
// opened without a start parameter inside Telegram (the DM menu button): a private one-person canvas
const param = tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('p') || (tg?.initData ? 's_me' : 's_dev');
const mode = param[0] === 't' ? 'together' : 'solo';
const token = param.slice(2);
const initData = tg?.initData || 'dev';
$('#mode').textContent = mode === 'together' ? '👥 together' : '✏️ alone';

// ---------- state ----------
const ops = [];                                   // everything drawn, in order (shared in a room)
let layers = [{ id: 'L1', name: 'Layer 1', visible: true, opacity: 1, blend: 'source-over' }];
let activeLayer = 'L1';
const layerCv = new Map();                        // layer id -> its own bitmap
let bg = '#ffffff';                               // canvas colour: a hex colour, or 'transparent'
let tool = 'pencil', prevTool = 'pencil';
let color = '#000000';
let symmetry = 0;                                 // 0 off, 1 mirror left/right, 2 mirror up/down, 3 both
let smooth = 0;                                   // stroke smoothing 0..10
let fillShapes = false;
let ws = null;
let uiReady = false;
const redoStack = [];                             // solo mode only (rooms keep it on the server)
const liveOps = new Set();                        // strokes still being drawn (mine and other people's)

const TOOLS = [
  { id: 'pencil', icon: '✏️', label: 'Pencil', size: 6, op: 1 },
  { id: 'pen', icon: '🖋️', label: 'Ink pen', size: 8, op: 1 },
  { id: 'marker', icon: '🖊️', label: 'Marker', size: 14, op: 0.6 },
  { id: 'brush', icon: '🖌️', label: 'Brush', size: 16, op: 1 },
  { id: 'airbrush', icon: '💨', label: 'Airbrush', size: 30, op: 0.6 },
  { id: 'chalk', icon: '🖍️', label: 'Chalk', size: 18, op: 1 },
  { id: 'highlighter', icon: '💛', label: 'Highlight', size: 20, op: 0.35 },
  { id: 'eraser', icon: '🧽', label: 'Eraser', size: 24, op: 1 },
  { id: 'fill', icon: '🪣', label: 'Bucket' },
  { id: 'eyedrop', icon: '💧', label: 'Pick colour' },
  { id: 'line', icon: '／', label: 'Line', size: 6, op: 1 },
  { id: 'rect', icon: '▭', label: 'Rectangle', size: 6, op: 1 },
  { id: 'ellipse', icon: '◯', label: 'Ellipse', size: 6, op: 1 },
  { id: 'text', icon: 'Aa', label: 'Text', size: 14, op: 1 },
  { id: 'select', icon: '⬚', label: 'Select', },
];
const cfg = Object.fromEntries(TOOLS.map((t) => [t.id, { size: t.size, op: t.op }]));   // each tool remembers its size + opacity
const hasSize = (t) => cfg[t].size !== undefined;
const COLORS = ['#000000', '#ffffff', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#00acc1', '#1e88e5', '#5e35b1', '#d81b60', '#8d6e63', '#9e9e9e'];

// ---------- helpers ----------
const newId = () => Math.random().toString(36).slice(2, 10);
const hexToRgb = (h) => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const rgbToHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rnd(st) { // small seeded random generator: every device draws chalk grain identically
  st.s = (st.s + 0x6d2b79f5) | 0;
  let t = Math.imul(st.s ^ (st.s >>> 15), 1 | st.s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const mirrors = (sym) => { const m = [[1, 1]]; if (sym & 1) m.push([-1, 1]); if (sym & 2) m.push([1, -1]); if (sym === 3) m.push([-1, -1]); return m; };
const makeCanvas = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; };
let scratch = makeCanvas(), sctx = scratch.getContext('2d');
let tmp = makeCanvas(), tctx = tmp.getContext('2d');
const pool = [];
const takeCanvas = () => { const c = pool.pop() || makeCanvas(); c.getContext('2d').clearRect(0, 0, W, H); return c; };
const giveCanvas = (c) => { if (pool.length < 4 && c.width === W && c.height === H) pool.push(c); };
const lcanvas = (id) => { let c = layerCv.get(id); if (!c) { c = makeCanvas(); layerCv.set(id, c); } return c; };
const lctx = (id) => lcanvas(id).getContext('2d', { willReadFrequently: true });
const layerById = (id) => layers.find((l) => l.id === id);
const findOp = (id) => { for (let i = ops.length - 1; i >= 0; i--) if (ops[i].id === id) return ops[i]; return null; };

// ---------- drawing the brushes ----------
function widthOf(t, sz) {
  if (t === 'pencil') return Math.max(1, sz * 0.5);
  if (t === 'marker') return sz * 1.4;
  if (t === 'brush') return sz * 1.8;
  if (t === 'highlighter') return sz * 2.2;
  return sz; // pen, eraser, chalk, shapes
}

// Draws the stroke's new points (from op._n onwards) in solid colour onto c. The stroke's
// opacity is applied afterwards, when the whole stroke is composited onto its layer.
function paintStroke(op, c) {
  const p = op.pts, n = p.length / 2;
  let i = op._n || 0;
  if (i >= n) return;
  if (i === 0) op._ds = null;
  const w = widthOf(op.tool, op.size);
  mirrors(op.sym || 0).forEach(([sx, sy], mi) => {
    const X = (k) => (sx < 0 ? W - p[2 * k] : p[2 * k]);
    const Y = (k) => (sy < 0 ? H - p[2 * k + 1] : p[2 * k + 1]);
    const pr = (k) => (op.pr ? 0.2 + 0.9 * (op.pr[k] ?? 50) / 100 : 1);
    c.save();
    c.lineCap = c.lineJoin = 'round';
    c.strokeStyle = c.fillStyle = c.shadowColor = op.color;
    if (op.tool === 'airbrush' || op.tool === 'chalk') {
      const st = ((op._ds ||= [])[mi] ||= { carry: 0, s: (hashStr(op.id) + mi * 7919) | 0, lx: null, ly: null });
      const r = op.tool === 'airbrush' ? op.size * 1.2 : op.size * 0.5;
      const step = Math.max(1, r * (op.tool === 'airbrush' ? 0.25 : 0.35));
      const [cr, cg, cb] = hexToRgb(op.color);
      const dab = (x, y, k) => {
        const rr = r * pr(k);
        if (op.tool === 'airbrush') {
          const g = c.createRadialGradient(x, y, 0, x, y, rr);
          g.addColorStop(0, `rgba(${cr},${cg},${cb},0.22)`); g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
          c.fillStyle = g; c.fillRect(x - rr, y - rr, rr * 2, rr * 2);
        } else {
          for (let j = 0; j < 7; j++) {
            const a = rnd(st) * Math.PI * 2, d = Math.sqrt(rnd(st)) * rr, sz = 0.6 + rnd(st) * rr * 0.18;
            c.globalAlpha = 0.35 + rnd(st) * 0.5;
            c.fillRect(x + Math.cos(a) * d, y + Math.sin(a) * d, sz, sz);
          }
          c.globalAlpha = 1;
        }
      };
      for (let k = i; k < n; k++) {
        const x = X(k), y = Y(k);
        if (st.lx === null) { dab(x, y, k); st.lx = x; st.ly = y; continue; }
        const dist = Math.hypot(x - st.lx, y - st.ly);
        if (dist === 0) continue;
        let t = step - st.carry;
        while (t <= dist) { const f = t / dist; dab(st.lx + (x - st.lx) * f, st.ly + (y - st.ly) * f, k); t += step; }
        st.carry = dist - (t - step); st.lx = x; st.ly = y;
      }
    } else if (op.pr) { // pen with pressure: width follows the pressure, segment by segment
      if (op.tool === 'brush') c.shadowBlur = w * 0.4;
      if (i === 0) { c.beginPath(); c.arc(X(0), Y(0), Math.max(0.5, w * pr(0) / 2), 0, Math.PI * 2); c.fill(); }
      for (let k = Math.max(1, i); k < n; k++) {
        c.lineWidth = Math.max(0.5, w * (pr(k) + pr(k - 1)) / 2);
        c.beginPath(); c.moveTo(X(k - 1), Y(k - 1)); c.lineTo(X(k), Y(k)); c.stroke();
      }
    } else {
      c.lineWidth = w;
      if (op.tool === 'brush') c.shadowBlur = w * 0.4;
      c.beginPath();
      let k = i;
      if (k === 0) { c.moveTo(X(0), Y(0)); c.lineTo(X(0), Y(0)); k = 1; } else c.moveTo(X(k - 1), Y(k - 1));
      for (; k < n; k++) c.lineTo(X(k), Y(k));
      c.stroke();
    }
    c.restore();
  });
  op._n = n;
}

function paintShape(op, c) {
  mirrors(op.sym || 0).forEach(([sx, sy]) => {
    const fx = (x) => (sx < 0 ? W - x : x), fy = (y) => (sy < 0 ? H - y : y);
    const x1 = fx(op.x1), y1 = fy(op.y1), x2 = fx(op.x2), y2 = fy(op.y2);
    c.save();
    c.lineCap = c.lineJoin = 'round';
    c.strokeStyle = c.fillStyle = op.color;
    c.lineWidth = op.size;
    c.beginPath();
    if (op.shape === 'line') { c.moveTo(x1, y1); c.lineTo(x2, y2); }
    else if (op.shape === 'rect') c.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    else c.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
    if (op.f && op.shape !== 'line') c.fill();
    c.stroke();
    c.restore();
  });
}

const FONT_FAMILY = { sans: 'system-ui, -apple-system, "Segoe UI", sans-serif', serif: 'Georgia, "Times New Roman", serif', mono: 'ui-monospace, Menlo, Consolas, monospace', hand: '"Marker Felt", "Chalkboard SE", "Comic Sans MS", cursive' };
function paintText(op, c) {
  c.save();
  c.fillStyle = op.color;
  c.textBaseline = 'top';
  c.font = `${op.font === 'hand' ? 700 : 600} ${op.size}px ${FONT_FAMILY[op.font] || FONT_FAMILY.sans}`;
  op.text.split('\n').forEach((line, i) => c.fillText(line, op.x, op.y + i * op.size * 1.2));
  c.restore();
}

// Deterministic so every participant ends up with the same pixels.
function floodFill(lc, x0, y0, hex) {
  x0 = Math.max(0, Math.min(W - 1, Math.round(x0)));
  y0 = Math.max(0, Math.min(H - 1, Math.round(y0)));
  const img = lc.getImageData(0, 0, W, H), d = img.data;
  const t = (y0 * W + x0) * 4;
  const tr = d[t], tg_ = d[t + 1], tb = d[t + 2], ta = d[t + 3];
  const [fr, fg, fb] = hexToRgb(hex);
  const clear = ta < 10;
  const match = (i) => clear
    ? d[i + 3] <= 150
    : Math.abs(d[i] - tr) + Math.abs(d[i + 1] - tg_) + Math.abs(d[i + 2] - tb) + Math.abs(d[i + 3] - ta) <= 60;
  const seen = new Uint8Array(W * H);
  const stack = [y0 * W + x0];
  while (stack.length) {
    const pi = stack.pop();
    if (seen[pi]) continue;
    const i = pi * 4;
    if (!match(i)) continue;
    seen[pi] = 1;
    const a = d[i + 3] / 255; // keep antialiased line edges on top of the fill
    d[i] = d[i] * a + fr * (1 - a);
    d[i + 1] = d[i + 1] * a + fg * (1 - a);
    d[i + 2] = d[i + 2] * a + fb * (1 - a);
    d[i + 3] = 255;
    const x = pi % W;
    if (x > 0) stack.push(pi - 1);
    if (x < W - 1) stack.push(pi + 1);
    if (pi >= W) stack.push(pi - W);
    if (pi < W * (H - 1)) stack.push(pi + W);
  }
  lc.putImageData(img, 0, 0);
}

// rotate/scale/move a rectangular piece of a layer
function drawMoved(dest, src, op) {
  const snap = document.createElement('canvas'); snap.width = op.w; snap.height = op.h;
  snap.getContext('2d').drawImage(src, op.x, op.y, op.w, op.h, 0, 0, op.w, op.h);
  dest.clearRect(op.x, op.y, op.w, op.h);
  dest.save();
  dest.translate(op.x + op.w / 2 + op.tx, op.y + op.h / 2 + op.ty);
  dest.rotate(op.r); dest.scale(op.s, op.s);
  dest.drawImage(snap, -op.w / 2, -op.h / 2);
  dest.restore();
}

// where a stroke/shape/text can have put pixels (so replays only touch that area)
function opBBox(op) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, pad;
  const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  if (op.k === 'stroke') {
    pad = widthOf(op.tool, op.size) * 1.6 + (op.tool === 'airbrush' ? op.size * 1.3 : 0) + 4;
    for (let i = 0; i < op.pts.length; i += 2) add(op.pts[i], op.pts[i + 1]);
  } else if (op.k === 'shape') { pad = op.size + 4; add(op.x1, op.y1); add(op.x2, op.y2); }
  else { return [0, 0, W, H]; }
  if (op.sym) { const a = [x0, y0, x1, y1]; add(W - a[0], a[1]); add(a[0], H - a[1]); add(W - a[2], a[3]); add(a[2], H - a[3]); }
  return [Math.max(0, Math.floor(x0 - pad)), Math.max(0, Math.floor(y0 - pad)), Math.min(W, Math.ceil(x1 + pad)), Math.min(H, Math.ceil(y1 + pad))];
}

// Put one finished operation onto its layer's bitmap.
function bakeOp(op) {
  try {
    const lc = lctx(op.l);
    if (op.k === 'stroke' || op.k === 'shape') {
      const [x0, y0, x1, y1] = opBBox(op);
      if (x1 <= x0 || y1 <= y0) return;
      sctx.clearRect(0, 0, W, H);
      if (op.k === 'stroke') { op._n = 0; paintStroke(op, sctx); } else paintShape(op, sctx);
      lc.save();
      lc.globalAlpha = op.op ?? 1;
      lc.globalCompositeOperation = op.tool === 'eraser' ? 'destination-out' : 'source-over';
      lc.drawImage(scratch, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
      lc.restore();
      sctx.clearRect(0, 0, W, H);
    } else if (op.k === 'fill') floodFill(lc, op.x, op.y, op.color);
    else if (op.k === 'text') { lc.save(); lc.globalAlpha = op.op ?? 1; paintText(op, lc); lc.restore(); }
    else if (op.k === 'move') drawMoved(lc, lcanvas(op.l), op);
  } catch (e) { console.warn('could not draw', op.k, e); }
}

function renderLayer(id) {
  lctx(id).clearRect(0, 0, W, H);
  for (const op of ops) if (op.l === id && !op._live) bakeOp(op);
}
function renderAll() {
  for (const l of layers) renderLayer(l.id);
  compose();
}

// ---------- live strokes ----------
function startLive(op) {
  op._live = true; op._cv = takeCanvas(); op._n = 0; op._t = performance.now();
  liveOps.add(op);
  paintStroke(op, op._cv.getContext('2d'));
}
function endStroke(op) {
  if (!op._live) return;
  const lc = lctx(op.l);
  lc.save();
  lc.globalAlpha = op.op ?? 1;
  lc.globalCompositeOperation = op.tool === 'eraser' ? 'destination-out' : 'source-over';
  lc.drawImage(op._cv, 0, 0);
  lc.restore();
  giveCanvas(op._cv); delete op._cv;
  op._live = false; liveOps.delete(op);
  const idx = ops.indexOf(op);
  if (ops.slice(idx + 1).some((o) => o.l === op.l && !o._live)) renderLayer(op.l); // keep drawing order exact
  compose();
}
setInterval(() => { // a collaborator who vanished mid-stroke: close their stroke
  const now = performance.now();
  for (const op of [...liveOps]) if (op !== curOp && now - op._t > 2500) endStroke(op);
}, 1000);

// ---------- compositing the layers ----------
let composeQueued = false;
function compose() {
  if (composeQueued) return;
  composeQueued = true;
  requestAnimationFrame(() => { composeQueued = false; composeNow(); });
}
function composeNow() {
  ctx.clearRect(0, 0, W, H);
  for (const L of layers) {
    if (!L.visible) continue;
    let src = lcanvas(L.id);
    if (sel && sel.l === L.id) { // a selection being moved floats above the rest of its layer
      tctx.clearRect(0, 0, W, H); tctx.drawImage(src, 0, 0);
      drawMoved(tctx, src, { ...sel, w: sel.w, h: sel.h });
      src = tmp;
    }
    const live = [...liveOps].filter((o) => o.l === L.id);
    if (live.length) {
      if (src !== tmp) { tctx.clearRect(0, 0, W, H); tctx.drawImage(src, 0, 0); }
      for (const o of live) {
        tctx.save(); tctx.globalAlpha = o.op ?? 1;
        tctx.globalCompositeOperation = o.tool === 'eraser' ? 'destination-out' : 'source-over';
        tctx.drawImage(o._cv, 0, 0); tctx.restore();
      }
      src = tmp;
    }
    ctx.globalAlpha = L.opacity;
    ctx.globalCompositeOperation = L.blend;
    ctx.drawImage(src, 0, 0);
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  drawOverlay();
}

// ---------- selection (rectangle you can move / rotate / scale) ----------
let sel = null; // { l, x, y, w, h, tx, ty, s, r }
function selCorners() {
  const cx = sel.x + sel.w / 2, cy = sel.y + sel.h / 2, cos = Math.cos(sel.r) * sel.s, sin = Math.sin(sel.r) * sel.s;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
    const dx = (a * sel.w) / 2, dy = (b * sel.h) / 2;
    return [cx + sel.tx + dx * cos - dy * sin, cy + sel.ty + dx * sin + dy * cos];
  });
}
function insideSel(x, y) {
  const cx = sel.x + sel.w / 2 + sel.tx, cy = sel.y + sel.h / 2 + sel.ty;
  const cos = Math.cos(-sel.r), sin = Math.sin(-sel.r);
  const lx = ((x - cx) * cos - (y - cy) * sin) / sel.s, ly = ((x - cx) * sin + (y - cy) * cos) / sel.s;
  return Math.abs(lx) <= sel.w / 2 && Math.abs(ly) <= sel.h / 2;
}
let dragRect = null, shapePreview = null;
function drawOverlay() {
  octx.clearRect(0, 0, W, H);
  const dash = (pts) => {
    octx.save(); octx.lineWidth = Math.max(2, W / 400); octx.setLineDash([10, 8]);
    octx.strokeStyle = '#fff'; octx.beginPath(); pts.forEach(([x, y], i) => (i ? octx.lineTo(x, y) : octx.moveTo(x, y))); octx.closePath(); octx.stroke();
    octx.lineDashOffset = 9; octx.strokeStyle = '#2f80ed'; octx.stroke(); octx.restore();
  };
  if (sel) dash(selCorners());
  if (dragRect) dash([[dragRect.x, dragRect.y], [dragRect.x + dragRect.w, dragRect.y], [dragRect.x + dragRect.w, dragRect.y + dragRect.h], [dragRect.x, dragRect.y + dragRect.h]]);
  if (shapePreview) { octx.save(); octx.globalAlpha = shapePreview.op; paintShape(shapePreview, octx); octx.restore(); }
  if (symmetry && uiReady) {
    octx.save(); octx.strokeStyle = 'rgba(47,128,237,.55)'; octx.lineWidth = Math.max(1.5, W / 600); octx.setLineDash([14, 10]);
    if (symmetry & 1) { octx.beginPath(); octx.moveTo(W / 2, 0); octx.lineTo(W / 2, H); octx.stroke(); }
    if (symmetry & 2) { octx.beginPath(); octx.moveTo(0, H / 2); octx.lineTo(W, H / 2); octx.stroke(); }
    octx.restore();
  }
}
function applySelection() {
  if (!sel) return;
  const s = sel; sel = null;
  if (s.tx || s.ty || s.s !== 1 || s.r) addOp({ id: newId(), k: 'move', l: s.l, x: s.x, y: s.y, w: s.w, h: s.h, tx: s.tx, ty: s.ty, s: s.s, r: s.r });
  updateSelBar(); compose();
}
function cancelSelection() { if (sel) { sel = null; updateSelBar(); compose(); } }
function selectRect(x, y, w, h) {
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  w = Math.min(W - x, Math.round(w)); h = Math.min(H - y, Math.round(h));
  if (w < 4 || h < 4) return;
  sel = { l: activeLayer, x, y, w, h, tx: 0, ty: 0, s: 1, r: 0 };
  updateSelBar(); compose();
}

// ---------- adding my own operations ----------
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m, (k, v) => (k[0] === '_' ? undefined : v))); }

// fills, shapes, text and moves arrive as one piece
function addOp(op) {
  ops.push(op); redoStack.length = 0;
  bakeOp(op); send({ t: 'op', op }); compose();
}

function undo() {
  if (sel) return cancelSelection();
  if (mode === 'together') return send({ t: 'undo' });
  const i = ops.length - 1;
  if (i < 0) return;
  const [op] = ops.splice(i, 1);
  if (op._live) { endStroke(op); }
  redoStack.push({ op, index: i });
  renderLayer(op.l); compose();
}
function redo() {
  if (mode === 'together') return send({ t: 'redo' });
  const item = redoStack.pop();
  if (!item || !layerById(item.op.l)) return;
  ops.splice(Math.min(item.index, ops.length), 0, item.op);
  renderLayer(item.op.l); compose();
}

// ---------- networking ----------
function connect() {
  const base = new URL(API || location.origin);
  const proto = base.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${base.host}/ws?token=${token}&initData=${encodeURIComponent(initData)}`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'init') {
      for (const o of [...liveOps]) endStroke(o);
      ops.length = 0; ops.push(...m.ops); layers = m.layers; ensureActive();
      setBg(m.bg, false); sizeKey = ''; setCanvasSize(m.size || 'square', false); peers(m.peers); renderLayersUI();
    } else if (m.t === 'sync') {
      for (const o of [...liveOps]) endStroke(o);
      ops.length = 0; ops.push(...m.ops); layers = m.layers; ensureActive(); renderAll(); renderLayersUI();
    } else if (m.t === 'op') {
      ops.push(m.op);
      if (m.op.k === 'stroke') { startLive(m.op); compose(); } else { bakeOp(m.op); compose(); }
    } else if (m.t === 'pts') {
      const o = findOp(m.id);
      if (o) { o.pts.push(...m.pts); if (o.pr && m.pr) o.pr.push(...m.pr); if (o._live) { o._t = performance.now(); paintStroke(o, o._cv.getContext('2d')); compose(); } else o._stale = true; }
    } else if (m.t === 'end') { const o = findOp(m.id); if (o?._live) endStroke(o); else if (o?._stale) { o._stale = false; renderLayer(o.l); compose(); } }
    else if (m.t === 'remove') { const i = ops.findIndex((o) => o.id === m.id); if (i >= 0) { const [o] = ops.splice(i, 1); if (o._live) { liveOps.delete(o); delete o._cv; } renderLayer(o.l); compose(); } }
    else if (m.t === 'insert') { ops.splice(Math.min(m.index, ops.length), 0, m.op); renderLayer(m.op.l); compose(); }
    else if (m.t === 'clear') { ops.length = 0; liveOps.clear(); renderAll(); }
    else if (m.t === 'bg') setBg(m.bg, false);
    else if (m.t === 'size') setCanvasSize(m.size, false);
    else if (m.t === 'peers') peers(m.n);
    else if (m.t === 'layer') {
      if (m.act === 'add') layers.splice(m.at, 0, m.layer);
      else if (m.act === 'upd') Object.assign(layerById(m.id) || {}, m.props);
      else if (m.act === 'order') layers = m.ids.map((id) => layerById(id)).filter(Boolean);
      ensureActive(); renderLayersUI(); compose();
    }
  };
  ws.onclose = () => { toast('Disconnected - reconnecting…'); setTimeout(connect, 1500); };
}
function peers(n) { $('#mode').textContent = `👥 ${n} drawing`; }
function ensureActive() { if (!layerById(activeLayer)) activeLayer = layers[layers.length - 1].id; }

// ---------- input: drawing, zoom, pan ----------
const stage = $('#stage');
const wrap = $('#wrap');
const view = { s: 1, tx: 0, ty: 0 };
const applyView = () => { wrap.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.s})`; $('#zoomReset').hidden = view.s === 1 && !view.tx && !view.ty; };
function pos(e) {
  const r = cv.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
}
const inCanvas = (x, y) => x >= 0 && y >= 0 && x <= W && y <= H;

const pointers = new Map();     // active touches/pens/mouse
let pinch = null;               // two-finger zoom/pan in progress
let pending = null;             // a stroke that has not started yet (waits for movement or a short delay)
let curOp = null, buf = [], bufPr = [], flushTimer = null;
let shapeStart = null, selDrag = null, sp = null;

function flush() {
  flushTimer = null;
  if (curOp && buf.length) { send({ t: 'pts', id: curOp.id, pts: buf, ...(curOp.pr ? { pr: bufPr } : {}) }); buf = []; bufPr = []; }
}
function opacityOf(t) { return cfg[t].op ?? 1; }

function beginStroke(x, y, pressure) {
  if (!layerById(activeLayer)?.visible) return toast('This layer is hidden - show it to draw on it');
  const op = { id: newId(), k: 'stroke', l: activeLayer, tool, color, size: cfg[tool].size, op: opacityOf(tool), sym: symmetry, pts: [x, y] };
  if (pressure != null) op.pr = [pressure];
  ops.push(op); redoStack.length = 0;
  startLive(op); curOp = op; sp = [x, y];
  send({ t: 'op', op });
  compose();
}
function extendStroke(rx, ry, pressure) {
  const k = smooth / 12;
  sp = [sp[0] + (rx - sp[0]) * (1 - k), sp[1] + (ry - sp[1]) * (1 - k)];
  curOp.pts.push(sp[0], sp[1]); buf.push(sp[0], sp[1]);
  if (curOp.pr) { curOp.pr.push(pressure ?? 50); bufPr.push(pressure ?? 50); }
  paintStroke(curOp, curOp._cv.getContext('2d')); compose();
  if (!flushTimer) flushTimer = setTimeout(flush, 40);
}
function finishStroke(rx, ry, pressure) {
  if (!curOp) return;
  if (smooth && rx != null && Math.hypot(rx - sp[0], ry - sp[1]) > 0.5) { const k = smooth; smooth = 0; extendStroke(rx, ry, pressure); smooth = k; }
  flush(); send({ t: 'end', id: curOp.id });
  endStroke(curOp); curOp = null;
}
const pressureOf = (e) => (e.pointerType === 'pen' && e.pressure > 0 ? Math.round(e.pressure * 100) : null);

function pickColourAt(x, y) {
  composeNow();
  const px = Math.max(0, Math.min(W - 1, Math.round(x))), py = Math.max(0, Math.min(H - 1, Math.round(y)));
  const d = ctx.getImageData(px, py, 1, 1).data;
  const a = d[3] / 255;
  const back = bg === 'transparent' ? [255, 255, 255] : hexToRgb(bg);
  if (a === 0 && bg === 'transparent') return;
  setColor(rgbToHex(d[0] * a + back[0] * (1 - a), d[1] * a + back[1] * (1 - a), d[2] * a + back[2] * (1 - a)));
}

stage.addEventListener('pointerdown', (e) => {
  if (e.target.closest('#selbar, button')) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { stage.setPointerCapture(e.pointerId); } catch {}
  if (pointers.size === 2) { beginPinch(); return; }
  if (pointers.size > 2 || pinch) return;
  if (e.button > 0) return;
  const [x, y] = pos(e);
  if (!inCanvas(x, y)) return;
  e.preventDefault();
  if (tool === 'fill') {
    if (!layerById(activeLayer)?.visible) return toast('This layer is hidden');
    return addOp({ id: newId(), k: 'fill', l: activeLayer, x, y, color });
  }
  if (tool === 'eyedrop') { pickColourAt(x, y); selDrag = { eye: true }; return; }
  if (tool === 'text') return openTextSheet(x, y);
  if (tool === 'select') {
    if (sel && insideSel(x, y)) selDrag = { move: true, lx: x, ly: y };
    else { applySelection(); selDrag = { rect: true, x0: x, y0: y }; dragRect = { x, y, w: 0, h: 0 }; }
    return;
  }
  if (tool === 'line' || tool === 'rect' || tool === 'ellipse') { shapeStart = [x, y]; return; }
  // brush-type tools: start on first movement (or a tap / short delay), so a second finger can still cancel
  pending = { x, y, pr: pressureOf(e), timer: setTimeout(() => { if (pending) { beginStroke(pending.x, pending.y, pending.pr); pending = null; } }, 90) };
});

stage.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX; p.y = e.clientY;
  if (pinch) { movePinch(); return; }
  if (pointers.size > 1) return;
  const [x, y] = pos(e);
  if (pending) { clearTimeout(pending.timer); beginStroke(pending.x, pending.y, pending.pr); pending = null; }
  if (curOp) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) { const [cx, cy] = pos(ev); extendStroke(cx, cy, pressureOf(ev)); }
  } else if (shapeStart) {
    const [x1, y1] = shapeStart;
    shapePreview = { k: 'shape', shape: tool, x1, y1, x2: x, y2: y, color, size: cfg[tool].size, op: opacityOf(tool), f: fillShapes, sym: symmetry };
    compose();
  } else if (selDrag?.rect) {
    dragRect = { x: Math.min(selDrag.x0, x), y: Math.min(selDrag.y0, y), w: Math.abs(x - selDrag.x0), h: Math.abs(y - selDrag.y0) }; compose();
  } else if (selDrag?.move && sel) {
    sel.tx += x - selDrag.lx; sel.ty += y - selDrag.ly; selDrag.lx = x; selDrag.ly = y; compose();
  } else if (selDrag?.eye) pickColourAt(x, y);
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  const wasPinch = !!pinch;
  pointers.delete(e.pointerId);
  if (wasPinch) { if (pointers.size < 2) pinch = null; return; }
  const [x, y] = pos(e);
  if (pending) { clearTimeout(pending.timer); beginStroke(pending.x, pending.y, pending.pr); pending = null; }
  if (curOp) finishStroke(x, y, pressureOf(e));
  if (shapeStart) {
    const pv = shapePreview; shapeStart = null; shapePreview = null;
    if (pv && Math.hypot(pv.x2 - pv.x1, pv.y2 - pv.y1) > 3 && layerById(activeLayer)?.visible) addOp({ id: newId(), l: activeLayer, ...pv });
    else compose();
  }
  if (selDrag?.rect) { const r = dragRect; dragRect = null; selDrag = null; if (r) selectRect(r.x, r.y, r.w, r.h); compose(); }
  else if (selDrag) { if (selDrag.eye) { selDrag = null; setTool(prevTool === 'eyedrop' ? 'pencil' : prevTool); } else selDrag = null; }
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

function beginPinch() {
  // a second finger turns whatever was starting into a zoom/pan gesture
  if (pending) { clearTimeout(pending.timer); pending = null; }
  if (curOp) finishStroke();
  shapeStart = null; shapePreview = null; dragRect = null; selDrag = null;
  const [a, b] = [...pointers.values()];
  const r = wrap.getBoundingClientRect();
  pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, s0: view.s, tx0: view.tx, ty0: view.ty, baseL: r.left - view.tx, baseT: r.top - view.ty };
  compose();
}
function movePinch() {
  const [a, b] = [...pointers.values()];
  const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const s = Math.min(8, Math.max(0.5, (pinch.s0 * d) / pinch.d0));
  // keep the point that was under the fingers under the fingers
  const lx = (pinch.mx - pinch.baseL - pinch.tx0) / pinch.s0, ly = (pinch.my - pinch.baseT - pinch.ty0) / pinch.s0;
  view.s = s; view.tx = mx - pinch.baseL - s * lx; view.ty = my - pinch.baseT - s * ly;
  applyView();
}
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = wrap.getBoundingClientRect(), baseL = r.left - view.tx, baseT = r.top - view.ty;
  const s = Math.min(8, Math.max(0.5, view.s * Math.exp(-e.deltaY * 0.0015)));
  const lx = (e.clientX - baseL - view.tx) / view.s, ly = (e.clientY - baseT - view.ty) / view.s;
  view.s = s; view.tx = e.clientX - baseL - s * lx; view.ty = e.clientY - baseT - s * ly;
  applyView();
}, { passive: false });
$('#zoomReset').addEventListener('click', () => { view.s = 1; view.tx = view.ty = 0; applyView(); });

// ---------- layout ----------
function fit() {
  const k = Math.min((stage.clientWidth - 16) / W, (stage.clientHeight - 16) / H);
  wrap.style.width = Math.max(100, Math.floor(W * k)) + 'px';
  wrap.style.height = Math.max(100, Math.floor(H * k)) + 'px';
  if (uiReady) updateToolUI();
}
addEventListener('resize', fit);
new ResizeObserver(fit).observe(stage);

// ---------- toolbar ----------
const toolRow = $('#toolrow');
TOOLS.forEach((t) => {
  const b = document.createElement('button');
  b.className = 'tool'; b.dataset.tool = t.id; b.title = t.label;
  b.innerHTML = `${t.icon}<small>${t.label}</small>`;
  b.addEventListener('click', () => setTool(t.id));
  toolRow.appendChild(b);
});
function setTool(id) {
  if (id === tool) return;
  if (tool === 'select' && id !== 'select') applySelection();
  if (id === 'eyedrop') prevTool = tool;
  tool = id;
  document.querySelectorAll('.tool').forEach((x) => x.classList.toggle('on', x.dataset.tool === id));
  updateToolUI();
  updateSelBar();
}

const sizeEl = $('#size'), opEl = $('#opacity');
function updateToolUI() {
  const sz = hasSize(tool), op = cfg[tool].op !== undefined;
  sizeEl.disabled = !sz; opEl.disabled = !op;
  if (sz) sizeEl.value = cfg[tool].size;
  if (op) opEl.value = Math.round(cfg[tool].op * 100);
  const meta = TOOLS.find((t) => t.id === tool);
  $('#sizeLabel').textContent = sz ? `${meta.label} · size ${cfg[tool].size}${op ? ` · ${Math.round(cfg[tool].op * 100)}%` : ''}` : meta.label;
  // preview dot: the real on-screen thickness and the opacity of the stroke
  const px = sz ? widthOf(tool, cfg[tool].size) * (wrap.clientWidth / W) * view.s : 6;
  const d = Math.max(2, Math.min(34, px));
  const dot = $('#dot i');
  dot.style.width = dot.style.height = d + 'px';
  dot.style.background = tool === 'eraser' ? 'transparent' : color;
  dot.style.opacity = op ? Math.max(0.15, cfg[tool].op) : 1;
  dot.style.border = tool === 'eraser' ? '2px dashed var(--hint)' : '0';
  $('#fillShape').hidden = !(tool === 'rect' || tool === 'ellipse');
}
sizeEl.addEventListener('input', () => { cfg[tool].size = +sizeEl.value; updateToolUI(); });
opEl.addEventListener('input', () => { cfg[tool].op = +opEl.value / 100; updateToolUI(); });

$('#symBtn').addEventListener('click', () => {
  symmetry = (symmetry + 1) % 4;
  $('#symBtn').textContent = ['⇋ Mirror: off', '⇋ Mirror: left/right', '⇵ Mirror: up/down', '✛ Mirror: both'][symmetry];
  $('#symBtn').classList.toggle('on', !!symmetry);
  compose();
});
$('#smooth').addEventListener('input', (e) => { smooth = +e.target.value; $('#smoothLabel').textContent = smooth ? `Smooth ${smooth}` : 'Smooth off'; });
$('#fillShape').addEventListener('click', () => { fillShapes = !fillShapes; $('#fillShape').textContent = fillShapes ? '▮ Filled' : '▭ Outline'; $('#fillShape').classList.toggle('on', fillShapes); });

// colours: 12 slots + a full picker, with the colours you used last
const pal = $('#palette');
COLORS.forEach((c) => {
  const b = document.createElement('button');
  b.className = 'sw'; b.style.background = c; b.dataset.c = c;
  b.addEventListener('click', () => setColor(c));
  pal.appendChild(b);
});
const custom = document.createElement('button');
custom.className = 'sw custom'; custom.title = 'Any colour';
custom.addEventListener('click', openPicker);
pal.appendChild(custom);

function setColor(c) {
  color = c;
  document.querySelectorAll('#palette .sw').forEach((b) => b.classList.toggle('sel', b.dataset.c === c));
  if (uiReady) updateToolUI();
  if (pickerOpen) { syncPicker(); }
}

// ----- colour picker sheet -----
let pickerOpen = false, pk = { h: 0, s: 1, v: 1 };
let recents = [];
try { recents = JSON.parse(localStorage.getItem('sj-recent') || '[]').filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 12); } catch {}
const svc = $('#svCanvas'), svx = svc.getContext('2d');
function hsv2hex(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return rgbToHex(f(5) * 255, f(3) * 255, f(1) * 255);
}
function hex2hsv(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
  return { h, s: mx ? d / mx : 0, v: mx };
}
function drawSV() {
  const w = svc.width, h = svc.height;
  svx.fillStyle = hsv2hex(pk.h, 1, 1); svx.fillRect(0, 0, w, h);
  let g = svx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, '#fff'); g.addColorStop(1, 'rgba(255,255,255,0)'); svx.fillStyle = g; svx.fillRect(0, 0, w, h);
  g = svx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, '#000'); svx.fillStyle = g; svx.fillRect(0, 0, w, h);
  svx.beginPath(); svx.arc(pk.s * w, (1 - pk.v) * h, 9, 0, Math.PI * 2); svx.lineWidth = 3; svx.strokeStyle = '#fff'; svx.stroke(); svx.lineWidth = 1; svx.strokeStyle = '#000'; svx.stroke();
}
function syncPicker() {
  drawSV();
  $('#hue').value = pk.h; $('#hexIn').value = color;
  $('#pkPrev').style.background = color;
}
function openPicker() {
  pk = hex2hsv(color); pickerOpen = true; $('#psheet').classList.add('show');
  const row = $('#recents'); row.innerHTML = '';
  recents.forEach((c) => { const b = document.createElement('button'); b.className = 'sw'; b.style.background = c; b.addEventListener('click', () => { pk = hex2hsv(c); setColor(c); }); row.appendChild(b); });
  syncPicker();
}
function closePicker() {
  pickerOpen = false; $('#psheet').classList.remove('show');
  recents = [color, ...recents.filter((c) => c !== color)].slice(0, 12);
  try { localStorage.setItem('sj-recent', JSON.stringify(recents)); } catch {}
}
function svFrom(e) {
  const r = svc.getBoundingClientRect();
  pk.s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); pk.v = 1 - Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  setColor(hsv2hex(pk.h, pk.s, pk.v));
}
let svDown = false;
svc.addEventListener('pointerdown', (e) => { svDown = true; svc.setPointerCapture(e.pointerId); svFrom(e); });
svc.addEventListener('pointermove', (e) => { if (svDown) svFrom(e); });
svc.addEventListener('pointerup', () => (svDown = false));
$('#hue').addEventListener('input', (e) => { pk.h = +e.target.value; setColor(hsv2hex(pk.h, pk.s, pk.v)); });
$('#hexIn').addEventListener('change', (e) => { const v = e.target.value.trim(); if (/^#?[0-9a-f]{6}$/i.test(v)) { const h = v[0] === '#' ? v : '#' + v; pk = hex2hsv(h); setColor(h.toLowerCase()); } });
$('#psheet').addEventListener('click', (e) => { if (e.target.id === 'psheet' || e.target.dataset.act === 'done') closePicker(); });

// ----- selection bar -----
function updateSelBar() {
  $('#selbar').hidden = tool !== 'select';
  ['selRotL', 'selRotR', 'selSmall', 'selBig', 'selOk', 'selNo'].forEach((id) => ($('#' + id).disabled = !sel));
}
$('#selAll').addEventListener('click', () => { applySelection(); selectRect(0, 0, W, H); });
$('#selRotL').addEventListener('click', () => { if (sel) { sel.r -= Math.PI / 12; compose(); } });
$('#selRotR').addEventListener('click', () => { if (sel) { sel.r += Math.PI / 12; compose(); } });
$('#selSmall').addEventListener('click', () => { if (sel) { sel.s = Math.max(0.1, sel.s / 1.1); compose(); } });
$('#selBig').addEventListener('click', () => { if (sel) { sel.s = Math.min(10, sel.s * 1.1); compose(); } });
$('#selOk').addEventListener('click', applySelection);
$('#selNo').addEventListener('click', cancelSelection);

// ----- text -----
let textAt = null;
function openTextSheet(x, y) {
  textAt = [x, y]; $('#tsheet').classList.add('show');
  $('#textIn').value = ''; setTimeout(() => $('#textIn').focus(), 50);
}
$('#tsheet').addEventListener('click', (e) => {
  if (e.target.id === 'tsheet' || e.target.dataset.act === 'tcancel') $('#tsheet').classList.remove('show');
  if (e.target.dataset.act === 'tadd') {
    const text = $('#textIn').value.trim();
    $('#tsheet').classList.remove('show');
    if (!text || !textAt) return;
    if (!layerById(activeLayer)?.visible) return toast('This layer is hidden');
    addOp({ id: newId(), k: 'text', l: activeLayer, text, x: textAt[0], y: textAt[1], color, size: cfg.text.size * 3 + 12, font: $('#fontSel').value, op: opacityOf('text') });
  }
});

// ----- our own dialogs: the browser's confirm()/prompt() boxes show the page's web address -----
function ask({ title = '', text = '', ok = 'OK', cancel = 'Cancel', input = null } = {}) {
  return new Promise((resolve) => {
    const sh = $('#dsheet'), inp = $('#dInput');
    $('#dTitle').textContent = title; $('#dText').textContent = text; $('#dText').hidden = !text;
    inp.hidden = input === null; if (input !== null) inp.value = input;
    $('#dOk').textContent = ok; $('#dCancel').textContent = cancel;
    const done = (v) => { sh.classList.remove('show'); $('#dOk').onclick = $('#dCancel').onclick = sh.onclick = inp.onkeydown = null; resolve(v); };
    const yes = () => done(input === null ? true : inp.value), no = () => done(input === null ? false : null);
    $('#dOk').onclick = yes; $('#dCancel').onclick = no;
    sh.onclick = (e) => { if (e.target === sh) no(); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') yes(); };
    sh.classList.add('show');
    if (input !== null) setTimeout(() => { inp.focus(); inp.select(); }, 50);
  });
}

// ----- undo / redo / clear -----
$('#undo').addEventListener('click', undo);
$('#redo').addEventListener('click', redo);
$('#clear').addEventListener('click', async () => {
  if (!(await ask({ title: 'Clear everything?', text: mode === 'together' ? 'This wipes the whole drawing, on every layer, for everyone.' : 'This wipes the whole drawing, on every layer.', ok: 'Clear' }))) return;
  cancelSelection();
  if (mode === 'together') send({ t: 'clear' }); else { for (const o of [...liveOps]) liveOps.delete(o); ops.length = 0; redoStack.length = 0; renderAll(); }
});
addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
});

// ----- layers -----
const lsheet = $('#lsheet');
const BLEND_NAMES = { 'source-over': 'Normal', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', darken: 'Darken', lighten: 'Lighten' };
function renderLayersUI() {
  $('#layerCount').textContent = layers.length;
  const list = $('#layerList'); list.innerHTML = '';
  [...layers].reverse().forEach((L, ri) => {
    const i = layers.length - 1 - ri;
    const row = document.createElement('div');
    row.className = 'lrow' + (L.id === activeLayer ? ' act' : '');
    row.innerHTML = `<div class="l1"><button class="eye" data-a="eye">${L.visible ? '👁' : '🚫'}</button><button class="lname" data-a="pick"></button>
      <button data-a="up" ${i === layers.length - 1 ? 'disabled' : ''}>▲</button><button data-a="down" ${i === 0 ? 'disabled' : ''}>▼</button><button data-a="del" ${layers.length < 2 ? 'disabled' : ''}>🗑</button></div>
      <div class="l2"><input type="range" min="0" max="100" value="${Math.round(L.opacity * 100)}" data-a="op"><select data-a="blend">${Object.entries(BLEND_NAMES).map(([v, n]) => `<option value="${v}" ${v === L.blend ? 'selected' : ''}>${n}</option>`).join('')}</select></div>`;
    row.querySelector('.lname').textContent = L.name;
    row.dataset.id = L.id;
    list.appendChild(row);
  });
  $('#addLayer').disabled = layers.length >= 8;
}
function layerChanged(L, props) { Object.assign(L, props); if (mode === 'together') send({ t: 'layer', act: 'upd', id: L.id, props }); compose(); }
lsheet.addEventListener('click', async (e) => {
  if (e.target === lsheet || e.target.dataset.act === 'done') return lsheet.classList.remove('show');
  const row = e.target.closest('.lrow'), a = e.target.dataset.a;
  if (e.target.id === 'addLayer') {
    if (layers.length >= 8) return;
    applySelection();
    const L = { id: newId().slice(0, 6), name: `Layer ${layers.length + 1}`, visible: true, opacity: 1, blend: 'source-over' };
    layers.push(L); activeLayer = L.id; lcanvas(L.id);
    if (mode === 'together') send({ t: 'layer', act: 'add', layer: L, at: layers.length - 1 });
    return renderLayersUI();
  }
  if (!row || !a) return;
  const L = layerById(row.dataset.id), i = layers.indexOf(L);
  if (a === 'pick') { if (activeLayer === L.id) { const n = await ask({ title: 'Layer name', input: L.name, ok: 'Save' }); if (n?.trim()) layerChanged(L, { name: n.trim().slice(0, 20) }); } else { applySelection(); activeLayer = L.id; } }
  else if (a === 'eye') layerChanged(L, { visible: !L.visible });
  else if (a === 'up' || a === 'down') {
    const j = a === 'up' ? i + 1 : i - 1;
    if (j < 0 || j >= layers.length) return;
    [layers[i], layers[j]] = [layers[j], layers[i]];
    if (mode === 'together') send({ t: 'layer', act: 'order', ids: layers.map((x) => x.id) });
    compose();
  } else if (a === 'del') {
    if (layers.length < 2 || !(await ask({ title: 'Delete layer?', text: `"${L.name}" and everything drawn on it will be removed.`, ok: 'Delete' }))) return;
    applySelection();
    if (mode === 'together') { send({ t: 'layer', act: 'del', id: L.id }); return; } // the server answers with a fresh copy for everyone
    for (let k = ops.length - 1; k >= 0; k--) if (ops[k].l === L.id) { liveOps.delete(ops[k]); ops.splice(k, 1); }
    layers = layers.filter((x) => x !== L); layerCv.delete(L.id); redoStack.length = 0; ensureActive(); renderAll();
  }
  renderLayersUI();
});
lsheet.addEventListener('input', (e) => {
  const row = e.target.closest('.lrow'); if (!row) return;
  const L = layerById(row.dataset.id);
  if (e.target.dataset.a === 'op') layerChanged(L, { opacity: +e.target.value / 100 });
});
lsheet.addEventListener('change', (e) => {
  const row = e.target.closest('.lrow'); if (!row) return;
  if (e.target.dataset.a === 'blend') layerChanged(layerById(row.dataset.id), { blend: e.target.value });
});
$('#layersBtn').addEventListener('click', () => { renderLayersUI(); lsheet.classList.add('show'); });

// ---------- canvas colour and size ----------
function setBg(v, announce = true) {
  if (v === 'white') v = '#ffffff';
  bg = v;
  wrap.classList.toggle('transparent', v === 'transparent');
  wrap.style.backgroundColor = v === 'transparent' ? '' : v;
  document.querySelectorAll('.csw').forEach((b) => b.classList.toggle('sel', b.dataset.c === v));
  if (announce && mode === 'together') send({ t: 'bg', bg: v });
}

function setCanvasSize(key, announce = true) {
  if (!PRESETS[key]) return;
  const changed = key !== sizeKey;
  sizeKey = key;
  [W, H] = PRESETS[key];
  if (changed) {
    cv.width = W; cv.height = H; ov.width = W; ov.height = H;
    scratch = makeCanvas(); sctx = scratch.getContext('2d'); tmp = makeCanvas(); tctx = tmp.getContext('2d');
    pool.length = 0; layerCv.clear();
    for (const o of liveOps) { delete o._cv; o._live = false; } liveOps.clear();
    sel = null;
  }
  document.querySelectorAll('.csize').forEach((b) => b.classList.toggle('sel', b.dataset.size === key));
  fit();
  renderAll();
  if (announce && mode === 'together') send({ t: 'size', size: key });
}

// ---- canvas settings sheet (size + colour) ----
const csheet = $('#csheet');
$('#bg').addEventListener('click', () => csheet.classList.add('show'));
csheet.addEventListener('click', (e) => { if (e.target === csheet || e.target.dataset.act === 'done') csheet.classList.remove('show'); });

document.querySelectorAll('.csize').forEach((b) => b.addEventListener('click', async () => {
  const key = b.dataset.size;
  if (key === sizeKey) return;
  if (ops.length && !(await ask({ title: 'Change canvas size?', text: (mode === 'together' ? 'Everyone will get the new size. ' : '') + 'Parts of the drawing outside the new size will be cropped.', ok: 'Change' }))) return;
  applySelection();
  setCanvasSize(key);
}));

const cpal = $('#cpalette');
['#ffffff', '#fffdf6', '#fde68a', '#fecaca', '#bfdbfe', '#bbf7d0', '#e9d5ff', '#d1d5db', '#6b7280', '#22223b', '#111111'].forEach((c) => {
  const b = document.createElement('button');
  b.className = 'sw csw'; b.style.background = c; b.dataset.c = c;
  b.addEventListener('click', () => setBg(c));
  cpal.appendChild(b);
});
const clearBtn = document.createElement('button');
clearBtn.className = 'sw csw checker'; clearBtn.dataset.c = 'transparent'; clearBtn.title = 'No background (transparent)';
clearBtn.addEventListener('click', () => setBg('transparent'));
cpal.appendChild(clearBtn);
const ccustom = document.createElement('div');
ccustom.className = 'sw custom';
ccustom.innerHTML = '<input type="color" value="#ffffff">';
ccustom.querySelector('input').addEventListener('input', (e) => setBg(e.target.value));
cpal.appendChild(ccustom);
setBg(bg, false);
document.querySelector('.csize[data-size=square]').classList.add('sel');

// ---------- first paint ----------
cv.width = W; cv.height = H; ov.width = W; ov.height = H;
fit();
document.querySelector('.tool[data-tool=pencil]').classList.add('on');
uiReady = true;
setColor(color);
updateToolUI();
updateSelBar();
renderLayersUI();
renderAll();

// everything must be on the layers (and the composite up to date) before a picture is made
function prepareForExport() {
  applySelection();
  for (const o of [...liveOps]) endStroke(o);
  composeNow();
}

// ---------- export ----------
const me = tg?.initDataUnsafe?.user;
const myName = me ? [me.first_name, me.last_name].filter(Boolean).join(' ') || me.username || `User ${me.id}` : 'Someone';
// how to tag someone in text: @username, else their name, else their user id
const myTag = me ? (me.username ? `@${me.username}` : myName) : 'Someone';
const soloInfo = () => ({ names: [myName], tags: [myTag] });

// Everyone who drew (shared room) or just you (alone): names for the footer, tags for captions.
async function artistNames() {
  if (mode !== 'together') return soloInfo();
  try {
    if (!serverUp) await ready;
    const r = await fetch(`${API}/api/artists`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData, token, mode }),
    });
    const j = await r.json();
    if (r.ok && j.names?.length) return { names: j.names, tags: j.tags?.length ? j.tags : j.names };
  } catch {}
  return soloInfo();
}

function joinNames(names, max = 3) {
  const list = names.length > max ? [...names.slice(0, max), `${names.length - max} more`] : names;
  return list.length < 2 ? list[0] : `${list.slice(0, -1).join(', ')} & ${list.at(-1)}`;
}
const tagLine = (tags) => `Drawn with ScribbleJam by ${joinNames(tags)}`;

// ---- credit footer (like a saved-image banner): deep purple bar under the picture ----
const logoImg = new Image();
let logoReady = false;
logoImg.onload = () => (logoReady = true);
logoImg.src = 'logo-white.png';

const FOOTER_BG = '#2b1166';
const footerH = (w) => Math.max(30, Math.round(w * 0.066));

function drawFooter(c, w, y0, fh, names) {
  c.save();
  c.fillStyle = FOOTER_BG;
  c.fillRect(0, y0, w, fh);
  const pad = fh * 0.45, mid = y0 + fh / 2;
  const font = (px, weight) => `${weight} ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  c.fillStyle = '#fff';
  c.textBaseline = 'middle';

  // ScribbleJam logo, white, on the right
  let logoW;
  if (logoReady) {
    const lh = fh * 0.5;
    logoW = (lh * logoImg.width) / logoImg.height;
    c.drawImage(logoImg, w - pad - logoW, mid - lh / 2, logoW, lh);
  } else {
    c.font = font(fh * 0.4, 700);
    logoW = c.measureText('ScribbleJam').width;
    c.fillText('ScribbleJam', w - pad - logoW, mid);
  }

  // "Drawn by <names>" on the left, shrunk / shortened to fit
  let fs = fh * 0.42;
  let text = `Drawn by ${joinNames(names)}`;
  const maxW = w - pad * 3 - logoW;
  c.font = font(fs, 500);
  while (c.measureText(text).width > maxW && fs > 9) { fs -= 1; c.font = font(fs, 500); }
  while (c.measureText(text).width > maxW && text.length > 12) text = text.slice(0, -2).trimEnd() + '…';
  c.fillText(text, pad, mid + fs * 0.04);
  c.restore();
}

// scale: 1 = full canvas; background: a colour or null for transparent;
// names: adds the credit footer below the picture (the picture itself is never covered).
function exportImage(scale, background, names = null, type = 'image/png') {
  prepareForExport();
  const w = Math.round(W * scale), h = Math.round(H * scale), fh = names ? footerH(w) : 0;
  const out = document.createElement('canvas');
  out.width = w; out.height = h + fh;
  const c = out.getContext('2d');
  if (background) { c.fillStyle = background; c.fillRect(0, 0, w, h); }
  c.drawImage(cv, 0, 0, w, h);
  if (names) drawFooter(c, w, h, fh, names);
  return out.toDataURL(type, 0.92);
}
const solidBg = () => (bg === 'transparent' ? '#ffffff' : bg);
const keepBg = () => (bg === 'transparent' ? null : bg);

async function api(action, png, extra = {}) {
  if (!serverUp) { toast('Waking the server up… one moment'); await ready; }
  const r = await fetch(`${API}/api/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ initData, token, mode, action, png, ...extra }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}

async function saveImage(names) {
  const png = exportImage(1, keepBg(), names);
  if (tg?.downloadFile && tg.isVersionAtLeast?.('8.0')) {
    const { url } = await api('host', png);
    tg.downloadFile({ url, file_name: 'ScribbleJam.png' }, (ok) => toast(ok ? 'Saved 💾' : 'Save cancelled'));
    return;
  }
  const a = document.createElement('a');
  a.href = png; a.download = 'ScribbleJam.png';
  document.body.appendChild(a); a.click(); a.remove();
  toast('Saving…');
}

async function shareToApps(names, tags) {
  const blob = await (await fetch(exportImage(1, keepBg(), names))).blob();
  const file = new File([blob], 'ScribbleJam.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], text: tagLine(tags) }); }
    catch (e) { if (e.name !== 'AbortError') throw e; }
    return;
  }
  toast('Sharing is not available here - saving instead');
  await saveImage(names);
}

const sheet = $('#sheet');
let namesP = Promise.resolve(soloInfo());
let postedSig = null; // which version of the drawing was already posted to the chat
const drawingSig = () => `${ops.length}:${ops.reduce((n, o) => n + (o.pts ? o.pts.length : 1), 0)}:${ops.at(-1)?.id}:${bg}:${sizeKey}:${layers.map((l) => l.id + l.visible + l.opacity + l.blend).join(',')}`;

// Finishing posts the picture (with the credit footer) to the chat it was started from.
async function postToChat() {
  const status = $('#sendStatus'), retry = $('#retry');
  retry.hidden = true;
  if (postedSig === drawingSig()) { status.textContent = '✅ Already sent to the chat'; return; }
  status.textContent = 'Sending to the chat…';
  try {
    const { names } = await namesP;
    const r = await api('print', exportImage(1, keepBg(), names), { bg: bg === 'transparent' ? 'transparent' : 'solid' });
    postedSig = drawingSig();
    status.textContent = r.duplicate ? '✅ Already sent to the chat' : '✅ Sent to the chat';
  } catch (err) {
    status.textContent = '⚠️ ' + err.message;
    retry.hidden = false;
  }
}

$('#share').addEventListener('click', () => { prepareForExport(); namesP = artistNames(); sheet.classList.add('show'); postToChat(); });
sheet.addEventListener('click', async (e) => {
  if (e.target === sheet) return sheet.classList.remove('show');
  const act = e.target.closest('button')?.dataset.act;
  if (!act) return;
  if (act === 'retry') return postToChat();
  sheet.classList.remove('show');
  if (act === 'close') return;
  try {
    // every painting carries the credit footer; stickers stay clean
    const info = act.startsWith('sticker') ? null : await namesP;
    const names = info?.names ?? null, tags = info?.tags ?? null;
    if (act === 'forward') {
      if (!(tg?.shareMessage && tg.isVersionAtLeast?.('8.0'))) { toast('Update Telegram to send to other chats - sharing to apps instead'); return shareToApps(names, tags); }
      const { id } = await api('prepare', exportImage(1, solidBg(), names, 'image/jpeg'), { w: W, h: H + footerH(W) });
      tg.shareMessage(id, (ok) => ok && toast('Shared ✅'));
    } else if (act === 'apps') {
      await shareToApps(names, tags);
    } else if (act === 'save') {
      await saveImage(names);
    } else if (act === 'story') {
      const { url } = await api('story', exportImage(1, solidBg(), names));
      if (tg?.shareToStory && tg.isVersionAtLeast?.('7.8')) tg.shareToStory(url, { text: tagLine(tags) });
      else toast('Your Telegram is too old for stories - please update it');
    } else {
      const { link } = await api('sticker', exportImage(512 / Math.max(W, H), act === 'sticker-white' ? solidBg() : null));
      toast('Sticker added! 🏷️');
      if (tg?.openTelegramLink) tg.openTelegramLink(link); else window.open(link);
    }
  } catch (err) { toast('⚠️ ' + err.message); }
});

let tt;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- waking the server ----------
// Free hosting naps when idle. Ping it so it wakes while the doodler is already drawing;
// shared rooms wait behind a ScribbleJam splash because they need the live connection.
let serverUp = false;
const boot = $('#boot');
$('#bootTitle').innerHTML = [...'ScribbleJam'].map((c, i) => `<span style="animation-delay:${i * 0.08}s">${c}</span>`).join('');

async function ping() {
  for (let i = 0; i < 60; i++) {
    try {
      const c = new AbortController(); const t = setTimeout(() => c.abort(), 5000);
      const r = await fetch(`${API}/healthz`, { signal: c.signal, cache: 'no-store' });
      clearTimeout(t);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}
let ready = ping().then((ok) => (serverUp = ok));

async function start() {
  if (mode !== 'together') return;
  boot.classList.add('show'); $('#bootRetry').hidden = true;
  $('#bootmsg').textContent = 'Loading…';
  const ok = await ready;
  if (!ok) { $('#bootmsg').textContent = 'The server is taking a long nap 😴'; $('#bootRetry').hidden = false; return; }
  connect();
  boot.classList.add('out'); setTimeout(() => boot.classList.remove('show', 'out'), 400);
}
$('#bootRetry').addEventListener('click', () => { ready = ping().then((ok) => (serverUp = ok)); start(); });
start();
