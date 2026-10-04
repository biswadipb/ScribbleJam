const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
try { if (tg?.disableVerticalSwipes) tg.disableVerticalSwipes(); } catch {} // otherwise a downward stroke can minimise the app

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
$('#mode').hidden = true;

// ---------- state ----------
const ops = [];                                   // everything drawn, in order (shared in a room)
let layers = [{ id: 'L1', name: 'Layer 1', visible: true, opacity: 1, blend: 'source-over' }];
let activeLayer = 'L1';
const layerCv = new Map();                        // layer id -> its own bitmap
let bg = '#ffffff';                               // canvas colour: a hex colour, or 'transparent'
let tool = 'pen', prevTool = 'pen';
let color = '#000000';
let mirrorLines = [];                             // dotted mirror lines you placed, each [x1, y1, x2, y2] (up to 3)
let mirrorOn = false;
let mirrorSel = -1;                               // the mirror line you tapped (its dots can be dragged)
let selShape = null;                              // the line / rectangle / ellipse you tapped, shown with handles
const SHAPE_TOOLS = new Set(['line', 'rect', 'ellipse']);
let smooth = 0;                                   // stroke smoothing 0..10
let fillShapes = false;
let ws = null;
let roomFull = false;
let uiReady = false;
const redoStack = [];                             // solo mode only (rooms keep it on the server)
const liveOps = new Set();                        // strokes still being drawn (mine and other people's)

const TOOLS = [
  { id: 'pen', icon: '🖊️', label: 'Pen', size: 6, max: 100, op: 1 },
  { id: 'eraser', icon: '🧽', label: 'Eraser', size: 24, op: 1 },
  { id: 'brush', icon: '🖌️', label: 'Brush', size: 16, op: 1 },
  { id: 'airbrush', icon: '💨', label: 'Airbrush', size: 30, op: 0.6 },
  { id: 'chalk', icon: '🖍️', label: 'Chalk', size: 18, op: 1 },
  { id: 'highlighter', icon: '💛', label: 'Highlight', size: 20, op: 0.35 },
  { id: 'fill', icon: '🪣', label: 'Bucket' },
  { id: 'eyedrop', icon: '💧', label: 'Pick colour' },
  { id: 'line', icon: '／', label: 'Line', size: 6, op: 1 },
  { id: 'rect', icon: '▭', label: 'Rectangle', size: 6, op: 1 },
  { id: 'ellipse', icon: '◯', label: 'Ellipse', size: 6, op: 1 },
  { id: 'mirror', icon: '🪞', label: 'Mirror' },
];
const cfg = Object.fromEntries(TOOLS.map((t) => [t.id, { size: t.size, op: t.op }]));   // each tool remembers its size + opacity
const hasSize = (t) => cfg[t].size !== undefined;
const COLORS = ['#000000', '#ffffff', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#00acc1', '#1e88e5', '#5e35b1', '#d81b60', '#8d6e63', '#9e9e9e'];

// ---------- saving your progress ----------
// The drawing is kept on this phone until you clear it (or 7 days after the last change), so closing the
// app, switching chats or a crash never loses it. In a shared room the server also keeps it while it is awake;
// if the server forgot it (it sleeps when idle), the first person to come back re-seeds it from their saved copy.
const SAVE_KEY = `sj1:${mode}:${token}`;
const KEEP_MS = 7 * 24 * 3600 * 1000;
const signedUsers = new Map();       // verified user records of everyone who drew here (kept for the credits)
let saveEnabled = false, saveTimer = null, firstDirty = 0, saveWarned = false;
function readSaved() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
    if (!s || !Array.isArray(s.ops) || !Array.isArray(s.layers) || Date.now() - s.t > KEEP_MS) { localStorage.removeItem(SAVE_KEY); return null; }
    return s;
  } catch { return null; }
}
function saveNow() {
  clearTimeout(saveTimer); saveTimer = null; firstDirty = 0;
  if (!saveEnabled) return;
  try {
    if (!ops.length && layers.length === 1 && bg === '#ffffff' && sizeKey === 'square') { localStorage.removeItem(SAVE_KEY); return; }
    localStorage.setItem(SAVE_KEY, JSON.stringify({ t: Date.now(), ops, layers, bg, size: sizeKey, users: [...signedUsers.values()] }, (k, v) => (k[0] === '_' ? undefined : v)));
  } catch { if (!saveWarned) { saveWarned = true; toast('Could not auto-save this drawing (phone storage is full)'); } }
}
function scheduleSave() { // soon after you stop drawing, and at least every few seconds while you keep going
  if (!saveEnabled) return;
  const now = Date.now(); if (!firstDirty) firstDirty = now;
  clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, Math.min(1000, Math.max(0, firstDirty + 5000 - now)));
}
addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
try { // tidy up drawings nobody came back to
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k?.startsWith('sj1:') && k !== SAVE_KEY) { const s = JSON.parse(localStorage.getItem(k) || '{}'); if (!s.t || Date.now() - s.t > KEEP_MS) localStorage.removeItem(k); }
  }
} catch {}
const savedDrawing = readSaved();

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
// Mirroring. A mirror line is [x1, y1, x2, y2]; a point is reflected across the (endless) line through them.
function reflector(l) {
  const dx = l[2] - l[0], dy = l[3] - l[1], len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
  return (x, y) => { const vx = x - l[0], vy = y - l[1], dot = vx * ux + vy * uy; return [l[0] + 2 * dot * ux - vx, l[1] + 2 * dot * uy - vy]; };
}
// every copy a stroke/shape is drawn as: the original first, then its reflections. Two lines give four copies
// (the original, across line 1, across line 2, and across both); three lines give eight.
function opTransforms(op) {
  if (op._ts) return op._ts;
  const id = (x, y) => [x, y];
  let ts = [id];
  if (op.mir?.length) {
    for (const l of op.mir) { const R = reflector(l); ts = ts.concat(ts.map((t) => (x, y) => { const q = t(x, y); return R(q[0], q[1]); })); }
  } else if (op.sym) { // drawings made with the older fixed centre mirror
    ts = [id];
    if (op.sym & 1) ts.push((x, y) => [W - x, y]);
    if (op.sym & 2) ts.push((x, y) => [x, H - y]);
    if (op.sym === 3) ts.push((x, y) => [W - x, H - y]);
  }
  return (op._ts = ts);
}
const mirrorActive = () => mirrorOn && mirrorLines.length > 0;
const mirrorForOp = () => (mirrorActive() ? { mir: mirrorLines.map((l) => [...l]) } : {});
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
// ('pencil' and 'marker' are no longer in the toolbar; old drawings that used them still draw the same)
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
  opTransforms(op).forEach((T, mi) => {
    const xs = [], ys = [];
    for (let k = Math.max(0, i - 1); k < n; k++) { const q = T(p[2 * k], p[2 * k + 1]); xs[k] = q[0]; ys[k] = q[1]; }
    const X = (k) => xs[k], Y = (k) => ys[k];
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
      let k = i;
      // the first point is an explicit filled dot: browsers disagree about drawing a zero-length line with round ends,
      // and a single click or tap must always leave a dot
      if (k === 0) { c.beginPath(); c.arc(X(0), Y(0), Math.max(0.5, w / 2), 0, Math.PI * 2); c.fill(); k = 1; }
      c.beginPath(); c.moveTo(X(k - 1), Y(k - 1));
      for (; k < n; k++) c.lineTo(X(k), Y(k));
      c.stroke();
    }
    c.restore();
  });
  op._n = n;
}

// a shape as a list of points, so it can be reflected across a mirror line at any angle
function shapeOutline(op) {
  const { x1, y1, x2, y2 } = op;
  if (op.shape === 'line') return { pts: [[x1, y1], [x2, y2]], closed: false };
  if (op.shape === 'rect') return { pts: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]], closed: true };
  const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2, ry = Math.abs(y2 - y1) / 2, pts = [];
  for (let i = 0; i < 120; i++) { const t = (i / 120) * Math.PI * 2; pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]); }
  return { pts, closed: true };
}
function paintShape(op, c) {
  opTransforms(op).forEach((T, i) => {
    c.save();
    c.lineCap = c.lineJoin = 'round';
    c.strokeStyle = c.fillStyle = op.color;
    c.lineWidth = op.size;
    c.beginPath();
    if (i === 0) { // the original, exactly as drawn
      const { x1, y1, x2, y2 } = op;
      if (op.shape === 'line') { c.moveTo(x1, y1); c.lineTo(x2, y2); }
      else if (op.shape === 'rect') c.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      else c.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
    } else {
      const o = shapeOutline(op);
      o.pts.forEach(([x, y], k) => { const q = T(x, y); if (k) c.lineTo(q[0], q[1]); else c.moveTo(q[0], q[1]); });
      if (o.closed) c.closePath();
    }
    if (op.f && op.shape !== 'line') c.fill();
    c.stroke();
    c.restore();
  });
}

// ---- bucket fill ----
// Lines stop the fill even when thin or soft. A finger rarely closes a shape perfectly, so if the colour would leak
// out to the edge of the canvas, gaps in the outline are bridged, trying the smallest bridge first, and the fill
// keeps the first size that makes the area enclosed. It is plain integer maths over the layer's own pixels, so every
// participant ends up with exactly the same result.
const GAP_LADDER = [5, 10, 18, 30];   // bridges gaps up to 10, 20, 36, 60 canvas pixels
// grow (dilate) or shrink (erode) a 0/1 mask by r pixels with a box window; cost does not depend on r
function boxMask(m, r, dilate) {
  const mid = new Uint8Array(W * H), out = new Uint8Array(W * H), pre = new Int32Array(Math.max(W, H) + 1);
  for (let y = 0; y < H; y++) {
    const row = y * W; pre[0] = 0;
    for (let x = 0; x < W; x++) pre[x + 1] = pre[x] + m[row + x];
    for (let x = 0; x < W; x++) { const lo = Math.max(0, x - r), hi = Math.min(W - 1, x + r), s = pre[hi + 1] - pre[lo]; mid[row + x] = dilate ? (s > 0 ? 1 : 0) : (s === hi - lo + 1 ? 1 : 0); }
  }
  for (let x = 0; x < W; x++) {
    pre[0] = 0;
    for (let y = 0; y < H; y++) pre[y + 1] = pre[y] + mid[y * W + x];
    for (let y = 0; y < H; y++) { const lo = Math.max(0, y - r), hi = Math.min(H - 1, y + r), s = pre[hi + 1] - pre[lo]; out[y * W + x] = dilate ? (s > 0 ? 1 : 0) : (s === hi - lo + 1 ? 1 : 0); }
  }
  return out;
}
function floodFill(lc, x0, y0, hex) {
  x0 = Math.max(0, Math.min(W - 1, Math.round(x0)));
  y0 = Math.max(0, Math.min(H - 1, Math.round(y0)));
  const n = W * H, img = lc.getImageData(0, 0, W, H), d = img.data;
  const t = (y0 * W + x0) * 4;
  const tr = d[t], tg_ = d[t + 1], tb = d[t + 2], ta = d[t + 3];
  const [fr, fg, fb] = hexToRgb(hex);
  const clear = ta < 10;               // tapping empty space (fill up to the lines) or tapping an existing colour (recolour it)
  const block = new Uint8Array(n);
  let walls0 = 0;
  if (clear) { for (let i = 0; i < n; i++) if (d[i * 4 + 3] >= 40) { block[i] = 1; walls0++; } }
  else {
    for (let i = 0; i < n; i++) { const j = i * 4; if (Math.abs(d[j] - tr) + Math.abs(d[j + 1] - tg_) + Math.abs(d[j + 2] - tb) + Math.abs(d[j + 3] - ta) > 60) block[i] = 1; }
  }
  const stack = new Int32Array(1 << 21);
  const touchesEdge = (seen) => {
    for (let x = 0; x < W; x++) if (seen[x] || seen[(H - 1) * W + x]) return true;
    for (let y = 0; y < H; y++) if (seen[y * W] || seen[y * W + W - 1]) return true;
    return false;
  };
  const floodFrom = (walls, seeds) => { // everything reachable from these start points without crossing a wall
    const seen = new Uint8Array(n); let sp = 0, area = 0;
    for (const s of seeds) if (sp < stack.length) stack[sp++] = s;
    while (sp > 0) { // fill whole rows at a time
      const i = stack[--sp];
      if (seen[i] || walls[i]) continue;
      const y = (i / W) | 0, row = y * W;
      let l = i - row, r = l;
      while (l > 0 && !walls[row + l - 1] && !seen[row + l - 1]) l--;
      while (r < W - 1 && !walls[row + r + 1] && !seen[row + r + 1]) r++;
      for (let x = l; x <= r; x++) seen[row + x] = 1;
      area += r - l + 1;
      for (const yy of [y - 1, y + 1]) {
        if (yy < 0 || yy >= H) continue;
        const rr = yy * W; let run = false;
        for (let x = l; x <= r; x++) {
          const free = !walls[rr + x] && !seen[rr + x];
          if (free && !run) { if (sp < stack.length) stack[sp++] = rr + x; run = true; } else if (!free) run = false;
        }
      }
    }
    return { seen, area };
  };
  const flood = (walls) => { // the area reachable from the tap (null if the tap is walled in)
    let seed = y0 * W + x0;
    if (walls[seed]) { // tapped right next to a line: use the closest free spot
      seed = -1;
      for (let r = 1; r <= 6 && seed < 0; r++) for (let dy = -r; dy <= r && seed < 0; dy++) for (let dx = -r; dx <= r; dx++) {
        const x = x0 + dx, y = y0 + dy;
        if (x >= 0 && y >= 0 && x < W && y < H && !walls[y * W + x]) { seed = y * W + x; break; }
      }
      if (seed < 0) return null;
    }
    return floodFrom(walls, [seed]);
  };
  // is there a properly closed shape anywhere on this layer? (free space that the canvas edge cannot reach)
  const closedShapeExists = () => {
    const edge = [];
    for (let x = 0; x < W; x++) { if (!block[x]) edge.push(x); if (!block[(H - 1) * W + x]) edge.push((H - 1) * W + x); }
    for (let y = 1; y < H - 1; y++) { if (!block[y * W]) edge.push(y * W); if (!block[y * W + W - 1]) edge.push(y * W + W - 1); }
    return n - walls0 - floodFrom(block, edge).area > 400;
  };
  let result = flood(block);
  if (!result) return null;
  let bridged = 0;
  if (clear && walls0 > 0 && touchesEdge(result.seen)) { // it leaks: close small gaps in the outline, smallest first
    for (const r of GAP_LADDER) {
      const attempt = flood(boxMask(boxMask(block, r, true), r, false));
      if (!attempt) break;               // a bigger bridge would only swallow the tapped spot
      if (!touchesEdge(attempt.seen)) { result = attempt; bridged = r; break; }
    }
  }
  let paint = result.seen;
  if (clear) { // also colour just under the line edges (never beyond a line into empty space)
    const grown = boxMask(result.seen, 2, true);
    paint = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (result.seen[i] || (grown[i] && d[i * 4 + 3] > 0)) paint[i] = 1;
  }
  for (let i = 0; i < n; i++) {
    if (!paint[i]) continue;
    const j = i * 4, al = d[j + 3] / 255;                   // keep antialiased line edges on top of the fill
    d[j] = d[j] * al + fr * (1 - al); d[j + 1] = d[j + 1] * al + fg * (1 - al); d[j + 2] = d[j + 2] * al + fb * (1 - al); d[j + 3] = 255;
  }
  lc.putImageData(img, 0, 0);
  const enclosed = !touchesEdge(result.seen);
  // only a layer with NO closed shape means "that outline was meant to be closed and is not"
  const leaked = clear && !enclosed && walls0 > 0 && result.area > n * 0.25 && !closedShapeExists();
  return { area: result.area, enclosed, bridged, hadWalls: walls0 > 0, leaked };
}

// where a stroke/shape can have put pixels (so replays only touch that area)
function opBBox(op) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, pad;
  const add = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  if (op.k === 'stroke') {
    pad = widthOf(op.tool, op.size) * 1.6 + (op.tool === 'airbrush' ? op.size * 1.3 : 0) + 4;
    for (let i = 0; i < op.pts.length; i += 2) add(op.pts[i], op.pts[i + 1]);
  } else if (op.k === 'shape') { pad = op.size + 4; add(op.x1, op.y1); add(op.x2, op.y2); }
  else { return [0, 0, W, H]; }
  const ts = opTransforms(op);
  if (ts.length > 1) { const cs = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]; for (const T of ts.slice(1)) for (const [cx, cy] of cs) { const q = T(cx, cy); add(q[0], q[1]); } }
  return [Math.max(0, Math.floor(x0 - pad)), Math.max(0, Math.floor(y0 - pad)), Math.min(W, Math.ceil(x1 + pad)), Math.min(H, Math.ceil(y1 + pad))];
}

// Put one finished operation onto a layer's bitmap (its own, or `target` for previews).
// `geom` is a shape's current position when it was moved later by an 'edit' operation.
function bakeOp(op, target = null, strict = false, geom = null) {
  try {
    const lc = target || lctx(op.l);
    if (op.k === 'stroke' || op.k === 'shape') {
      const eff = op.k === 'shape' && geom ? (opTransforms(op), { ...op, ...geom }) : op;
      const [x0, y0, x1, y1] = opBBox(eff);
      if (x1 <= x0 || y1 <= y0) return;
      sctx.clearRect(0, 0, W, H);
      if (op.k === 'stroke') { op._n = 0; paintStroke(op, sctx); } else paintShape(eff, sctx);
      lc.save();
      lc.globalAlpha = op.op ?? 1;
      lc.globalCompositeOperation = op.tool === 'eraser' ? 'destination-out' : 'source-over';
      lc.drawImage(scratch, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
      lc.restore();
      sctx.clearRect(0, 0, W, H);
    } else if (op.k === 'fill') op._fill = floodFill(lc, op.x, op.y, op.color);
    // an 'edit' draws nothing itself: it changes where its shape is drawn (see editsFor)
  } catch (e) { if (strict) throw e; console.warn('could not draw', op.k, e); }
}

// where moved shapes now are: the latest 'edit' for each shape on this layer
function editsFor(id) {
  const m = new Map();
  for (const o of ops) if (o.k === 'edit' && o.l === id) m.set(o.t, { x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2 });
  return m;
}
function drawLayerOps(target, id, skipId = null) {
  const edits = editsFor(id);
  for (const op of ops) if (op.l === id && !op._live && op.id !== skipId) bakeOp(op, target, false, edits.get(op.id));
}

function renderLayer(id) {
  lctx(id).clearRect(0, 0, W, H);
  drawLayerOps(lctx(id), id);
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
  scheduleSave();
  if (composeQueued) return;
  composeQueued = true;
  requestAnimationFrame(() => { composeQueued = false; composeNow(); });
}
function composeNow() {
  ctx.clearRect(0, 0, W, H);
  for (const L of layers) {
    if (!L.visible) continue;
    let src = lcanvas(L.id);
    if (shapeEdit && shapeEdit.l === L.id) { // a shape being moved: the layer without it, plus the shape at its new place
      const so = findOp(shapeEdit.id);
      if (so) {
        tctx.clearRect(0, 0, W, H); tctx.drawImage(shapeEdit.base, 0, 0);
        tctx.save(); tctx.globalAlpha = so.op ?? 1; opTransforms(so); paintShape({ ...so, ...shapeEdit.geom }, tctx); tctx.restore();
        src = tmp;
      }
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

let shapePreview = null;
function drawOverlay() {
  octx.clearRect(0, 0, W, H);
  if (shapePreview) { octx.save(); octx.globalAlpha = shapePreview.op; paintShape(shapePreview, octx); octx.restore(); }
  if (selShape && SHAPE_TOOLS.has(tool)) drawShapeHandles();
  if (uiReady && mirrorLines.length && (mirrorOn || tool === 'mirror')) drawMirrorLines(mirrorLines, mirrorOn ? 'rgba(47,128,237,.85)' : 'rgba(110,110,110,.7)', tool === 'mirror' ? mirrorSel : -1);
  if (mirrorDrag?.line) drawMirrorLines([mirrorDrag.line], 'rgba(230,57,70,.95)');
}
function drawMirrorLines(lines, colour, sel = -1) {
  octx.save(); octx.setLineDash([18, 12]); octx.lineCap = 'round';
  lines.forEach(([x1, y1, x2, y2], i) => {
    octx.lineWidth = Math.max(2, W / 380) * (i === sel ? 1.8 : 1);
    const len = Math.hypot(x2 - x1, y2 - y1) || 1, ux = (x2 - x1) / len, uy = (y2 - y1) / len, far = 6000;
    octx.strokeStyle = 'rgba(255,255,255,.9)'; octx.beginPath(); octx.moveTo(x1 - ux * far, y1 - uy * far); octx.lineTo(x1 + ux * far, y1 + uy * far); octx.stroke();
    octx.lineDashOffset = 15; octx.strokeStyle = colour; octx.stroke(); octx.lineDashOffset = 0;
  });
  octx.restore();
  const l = lines[sel]; // the selected line shows two dots: drag one to turn the line
  if (l) {
    octx.save(); octx.lineWidth = 2.5 / screenScale(); octx.strokeStyle = '#2f80ed'; octx.fillStyle = '#fff';
    for (const [hx, hy] of [[l[0], l[1]], [l[2], l[3]]]) { octx.beginPath(); octx.arc(hx, hy, handleR(), 0, Math.PI * 2); octx.fill(); octx.stroke(); }
    octx.restore();
  }
}

// ---------- the bucket, as the person using it sees it ----------
let fillBusy = false;
// wait for the next paint so 'Filling…' shows first, but never rely on it alone: a hidden or throttled webview may not paint at all
const nextFrame = () => new Promise((r) => { let done = false; const go = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(() => setTimeout(go, 0)); setTimeout(go, 80); });
function hideToast() { $('#toast').classList.remove('show'); }
async function doFill(x, y) {
  if (fillBusy) return;
  const layer = layerById(activeLayer);
  if (!layer?.visible) return toast('This layer is hidden - show it to fill on it');
  fillBusy = true;
  toast('Filling…');
  await nextFrame();                       // let "Filling…" appear before the work starts (a phone can take a moment)
  const op = { id: newId(), k: 'fill', l: activeLayer, x, y, color };
  try {
    ops.push(op); redoStack.length = 0;
    bakeOp(op, null, true);
    if (!op._fill) throw new Error('nothing to fill here');
    send({ t: 'op', op }); compose();
    const st = op._fill;
    if (st.leaked) toast('That outline is not closed, so the colour spread over a big area. Tap ↩️ to undo, close the gap and try again.');
    else if (!st.hadWalls && ops.some((o) => o !== op && o.l !== activeLayer && (o.k === 'stroke' || o.k === 'shape'))) toast(`"${layer.name}" is empty, so the colour covered the whole layer. Undo with ↩️ and switch to the layer you drew on.`);
    else hideToast();
  } catch (e) {
    const i = ops.indexOf(op); if (i >= 0) ops.splice(i, 1);
    renderLayer(op.l); compose();
    toast(`Could not fill here (${e.message || 'error'})`);
  } finally { fillBusy = false; }
}

// ---------- moving shapes and mirror lines ----------
// css pixels per canvas pixel right now (so handles and touch targets stay finger-sized at any zoom)
const screenScale = () => (wrap.clientWidth / W) * view.s;
const handleR = () => Math.min(70, Math.max(9, 13 / screenScale()));
// where a shape is now: its own corners, or the latest 'edit' that moved it
function effGeom(op) {
  for (let i = ops.length - 1; i >= 0; i--) { const o = ops[i]; if (o.k === 'edit' && o.t === op.id) return { x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2 }; }
  return { x1: op.x1, y1: op.y1, x2: op.x2, y2: op.y2 };
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
// how far a point is from a shape's outline (0 when it is inside a filled shape)
function shapeDist(g, shape, filled, x, y) {
  if (shape === 'line') return segDist(x, y, g.x1, g.y1, g.x2, g.y2);
  if (shape === 'rect') {
    const l = Math.min(g.x1, g.x2), r = Math.max(g.x1, g.x2), t = Math.min(g.y1, g.y2), b = Math.max(g.y1, g.y2);
    if (filled && x >= l && x <= r && y >= t && y <= b) return 0;
    return Math.min(segDist(x, y, l, t, r, t), segDist(x, y, r, t, r, b), segDist(x, y, r, b, l, b), segDist(x, y, l, b, l, t));
  }
  const cx = (g.x1 + g.x2) / 2, cy = (g.y1 + g.y2) / 2, rx = Math.abs(g.x2 - g.x1) / 2 || 1, ry = Math.abs(g.y2 - g.y1) / 2 || 1;
  const k = Math.hypot((x - cx) / rx, (y - cy) / ry);
  return filled && k <= 1 ? 0 : Math.abs(k - 1) * Math.min(rx, ry);
}
function handlesOf(g, shape) {
  if (shape === 'line') return [{ x: g.x1, y: g.y1, kx: 'x1', ky: 'y1' }, { x: g.x2, y: g.y2, kx: 'x2', ky: 'y2' }];
  return [{ x: g.x1, y: g.y1, kx: 'x1', ky: 'y1' }, { x: g.x2, y: g.y1, kx: 'x2', ky: 'y1' }, { x: g.x2, y: g.y2, kx: 'x2', ky: 'y2' }, { x: g.x1, y: g.y2, kx: 'x1', ky: 'y2' }];
}
function hitShape(x, y) { // the topmost visible shape under a finger
  const tol = Math.max(16, 15 / screenScale());
  for (let i = ops.length - 1; i >= 0; i--) {
    const o = ops[i];
    if (o.k !== 'shape' || !layerById(o.l)?.visible) continue;
    if (shapeDist(effGeom(o), o.shape, o.f, x, y) <= tol + o.size / 2) return o;
  }
  return null;
}
// dragging a shape (or one of its corner dots): show it moving over the layer-without-it, then store one 'edit'
function beginShapeEdit(op, how, x, y) {
  const base = makeCanvas();
  drawLayerOps(base.getContext('2d', { willReadFrequently: true }), op.l, op.id);
  const g0 = effGeom(op);
  shapeEdit = { id: op.id, l: op.l, how, sx: x, sy: y, g0, geom: { ...g0 }, base, moved: false };
  compose();
}
function updateShapeEdit(x, y) {
  const e = shapeEdit, dx = x - e.sx, dy = y - e.sy;
  if (Math.hypot(dx, dy) > 3 / screenScale()) e.moved = true;
  if (!e.moved) return;
  e.geom = e.how.body ? { x1: e.g0.x1 + dx, y1: e.g0.y1 + dy, x2: e.g0.x2 + dx, y2: e.g0.y2 + dy } : { ...e.g0, [e.how.handle.kx]: x, [e.how.handle.ky]: y };
  compose();
}
function endShapeEdit() {
  const e = shapeEdit; shapeEdit = null;
  if (e.moved) addOp({ id: newId(), k: 'edit', l: e.l, t: e.id, ...e.geom }); else compose();
}
function drawShapeHandles() {
  const so = findOp(selShape);
  if (!so) { selShape = null; return; }
  const g = shapeEdit?.id === so.id ? shapeEdit.geom : effGeom(so), r = handleR(), lw = 2.5 / screenScale();
  octx.save();
  if (so.shape !== 'line') {
    octx.lineWidth = lw; octx.setLineDash([10 / screenScale(), 7 / screenScale()]); octx.strokeStyle = '#2f80ed';
    octx.strokeRect(Math.min(g.x1, g.x2), Math.min(g.y1, g.y2), Math.abs(g.x2 - g.x1), Math.abs(g.y2 - g.y1));
    octx.setLineDash([]);
  }
  for (const h of handlesOf(g, so.shape)) { octx.beginPath(); octx.arc(h.x, h.y, r, 0, Math.PI * 2); octx.fillStyle = '#fff'; octx.fill(); octx.lineWidth = lw; octx.strokeStyle = '#2f80ed'; octx.stroke(); }
  octx.restore();
}
function mirrorHit(x, y) { // what is under a finger: a dot of the selected mirror line, a line, or nothing
  const hr = handleR() * 1.7, tol = Math.max(18, 14 / screenScale());
  const l = mirrorLines[mirrorSel];
  if (l) {
    if (Math.hypot(l[0] - x, l[1] - y) <= hr) return { i: mirrorSel, mode: 'p0' };
    if (Math.hypot(l[2] - x, l[3] - y) <= hr) return { i: mirrorSel, mode: 'p1' };
  }
  let best = -1, bd = tol;
  mirrorLines.forEach((ml, i) => { const d = distToLine(x, y, ml); if (d < bd) { bd = d; best = i; } });
  return best >= 0 ? { i: best, mode: 'move' } : null;
}
function moveMirrorEdit(x, y) {
  const e = mirrorEdit, l0 = e.l0, dx = x - e.sx, dy = y - e.sy;
  if (Math.hypot(dx, dy) > 4 / screenScale()) e.moved = true;
  if (!e.moved) return;
  let l;
  if (e.mode === 'move') l = [l0[0] + dx, l0[1] + dy, l0[2] + dx, l0[3] + dy];
  else if (e.mode === 'p0') { const s = snapLine(l0[2], l0[3], x, y); l = [s[2], s[3], l0[2], l0[3]]; }   // turn it around the other dot
  else { const s = snapLine(l0[0], l0[1], x, y); l = [l0[0], l0[1], s[2], s[3]]; }
  mirrorLines[e.i] = l.map((n) => Math.round(n * 10) / 10);
  compose();
}

// ---------- adding my own operations ----------
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m, (k, v) => (k[0] === '_' ? undefined : v))); }

// fills and shapes arrive as one piece
function addOp(op) {
  ops.push(op); redoStack.length = 0;
  if (op.k === 'edit') renderLayer(op.l); else bakeOp(op);
  send({ t: 'op', op }); compose();
}

function undo() {
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
  let pass = '';
  try { pass = localStorage.getItem('sj1pass:' + token) || ''; } catch {}
  ws = new WebSocket(`${proto}://${base.host}/ws?token=${token}&initData=${encodeURIComponent(initData)}${pass ? '&pass=' + encodeURIComponent(pass) : ''}`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'init') {
      for (const o of [...liveOps]) endStroke(o);
      // my own copy of the drawing: what is on screen right now (we may just have reconnected), else what was saved earlier
      const mine = ops.length ? { ops: ops.map((o) => JSON.parse(JSON.stringify(o, (k, v) => (k[0] === '_' ? undefined : v)))), layers: layers.map((l) => ({ ...l })), bg, size: sizeKey, users: [...signedUsers.values()] } : savedDrawing;
      ops.length = 0; ops.push(...m.ops); layers = m.layers; ensureActive();
      for (const x of m.users || []) signedUsers.set(x.u.id, x);
      policy = m.policy === 'c' ? 'c' : 'o'; inviteLink = m.invite || null;
      for (const u of m.pending || []) addJoinReq(u);
      setBg(m.bg, false); sizeKey = ''; setCanvasSize(m.size || 'square', false); peers(m.peers); renderLayersUI();
      hideBoot();
      if (m.fresh && mine?.ops?.length) { // the server has no copy (it slept or restarted): offer ours
        saveEnabled = false; // keep our saved copy untouched until the server has answered
        send({ t: 'restore', ops: mine.ops, layers: mine.layers, bg: mine.bg, size: mine.size, users: mine.users || [] });
        toast('Bringing your drawing back…');
        setTimeout(() => { saveEnabled = true; scheduleSave(); }, 3000); // in case someone else restored first
      } else { saveEnabled = true; scheduleSave(); }
    } else if (m.t === 'sync') {
      for (const o of [...liveOps]) endStroke(o);
      ops.length = 0; ops.push(...m.ops); layers = m.layers; ensureActive();
      if (m.bg) setBg(m.bg, false);
      if (m.size && m.size !== sizeKey) setCanvasSize(m.size, false); else renderAll();
      renderLayersUI(); saveEnabled = true; scheduleSave();
    } else if (m.t === 'user') signedUsers.set(m.user.u.id, m.user);
    else if (m.t === 'full') {
      const i = ops.findIndex((o) => o.id === m.id);
      if (i >= 0) { const [o] = ops.splice(i, 1); liveOps.delete(o); delete o._cv; renderLayer(o.l); compose(); }
      toast('This drawing is full - clear it or delete a layer to keep drawing');
    } else if (m.t === 'roomfull') { roomFull = true; bootNote(`This drawing already has ${m.max} people.\nTry again in a bit.`, true); }
    else if (m.t === 'waiting') bootNote(m.someoneInside ? '🔒 This drawing is closed.\nWaiting for someone to let you in…' : '🔒 This drawing is closed.\nNobody is in it right now - waiting for the host…', true);
    else if (m.t === 'admitted') { try { localStorage.setItem('sj1pass:' + token, m.pass); } catch {} bootNote('You are in! Opening the drawing…'); }
    else if (m.t === 'declined') { roomFull = true; bootNote('😕 Not this time.\nAsk the people drawing to let you in.', true); }
    else if (m.t === 'busy') { roomFull = true; bootNote('Lots of people are waiting at the door.\nTry again in a minute.', true); }
    else if (m.t === 'joinreq') addJoinReq(m.user);
    else if (m.t === 'joinreq-cancel') removeJoinReq(m.id);
    else if (m.t === 'op') {
      ops.push(m.op);
      if (m.op.k === 'stroke') { startLive(m.op); compose(); } else if (m.op.k === 'edit') { renderLayer(m.op.l); compose(); } else { bakeOp(m.op); compose(); }
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
  ws.onclose = () => { if (roomFull) return; toast('Disconnected - reconnecting…'); setTimeout(connect, 1500); };
}
let policy = 'o', inviteLink = null;
// the number of people drawing lives on the Invite button, which keeps the top bar short
function peers(n) { $('#inviteBtn').textContent = `➕ ${n}${policy === 'c' ? '🔒' : ''}`; $('#inviteBtn').title = `${n} drawing - invite more people`; }
function ensureActive() { if (!layerById(activeLayer)) activeLayer = layers[layers.length - 1].id; }

// ---------- input: drawing, zoom, pan ----------
const stage = $('#stage');
const wrap = $('#wrap');
const view = { s: 1, tx: 0, ty: 0, rot: 0 };   // rot: quarter turns clockwise (the picture itself is never changed)
const applyView = () => {
  wrap.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.s}) rotate(${view.rot * 90}deg)`;
  $('#zoomReset').hidden = view.s === 1 && !view.tx && !view.ty && !view.rot;
};
// where on the picture a finger is, whichever way the canvas is turned
function pos(e) {
  const r = cv.getBoundingClientRect();
  const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
  if (view.rot === 1) return [v * W, (1 - u) * H];
  if (view.rot === 2) return [(1 - u) * W, (1 - v) * H];
  if (view.rot === 3) return [(1 - v) * W, u * H];
  return [u * W, v * H];
}
const inCanvas = (x, y) => x >= 0 && y >= 0 && x <= W && y <= H;

const pointers = new Map();     // active touches/pens/mouse
let pinch = null;               // two-finger zoom/pan in progress
let pending = null;             // a stroke that has not started yet (waits for movement or a short delay)
let curOp = null, buf = [], bufPr = [], flushTimer = null;
let shapeStart = null, eyeDrag = false, mirrorDrag = null, shapeEdit = null, mirrorEdit = null, sp = null;

function flush() {
  flushTimer = null;
  if (curOp && buf.length) { send({ t: 'pts', id: curOp.id, pts: buf, ...(curOp.pr ? { pr: bufPr } : {}) }); buf = []; bufPr = []; }
}
function opacityOf(t) { return cfg[t].op ?? 1; }

function beginStroke(x, y, pressure) {
  if (!layerById(activeLayer)?.visible) return toast('This layer is hidden - show it to draw on it');
  const op = { id: newId(), k: 'stroke', l: activeLayer, tool, color, size: cfg[tool].size, op: opacityOf(tool), pts: [x, y], ...mirrorForOp() };
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
  if (e.target.closest('button')) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { stage.setPointerCapture(e.pointerId); } catch {}
  if (pointers.size === 2) { beginPinch(); return; }
  if (pointers.size > 2 || pinch) return;
  if (e.button > 0) return;
  const [x, y] = pos(e);
  if (!inCanvas(x, y)) return;
  e.preventDefault();
  if (tool === 'fill') return doFill(x, y);
  if (tool === 'eyedrop') { pickColourAt(x, y); eyeDrag = true; return; }
  if (tool === 'mirror') {
    const hit = mirrorHit(x, y);
    if (hit) { mirrorSel = hit.i; mirrorEdit = { ...hit, sx: x, sy: y, l0: [...mirrorLines[hit.i]], moved: false }; updateMirrorUI(); compose(); }
    else mirrorDrag = { x0: x, y0: y, line: null };      // empty space: a new line starts here
    return;
  }
  if (SHAPE_TOOLS.has(tool)) {
    const so = selShape && findOp(selShape);
    if (so && layerById(so.l)?.visible) { // the selected shape: its dots resize it, its body moves it
      const g = effGeom(so), hr = handleR() * 1.7;
      const h = handlesOf(g, so.shape).find((p) => Math.hypot(p.x - x, p.y - y) <= hr);
      if (h) return beginShapeEdit(so, { handle: h }, x, y);
      if (shapeDist(g, so.shape, so.f, x, y) <= Math.max(handleR(), so.size / 2 + 8)) return beginShapeEdit(so, { body: true }, x, y);
    }
    shapeStart = [x, y];                                  // otherwise: a new shape (or, if it is only a tap, select the shape tapped)
    return;
  }
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
  } else if (shapeEdit) {
    updateShapeEdit(x, y);
  } else if (mirrorEdit) {
    moveMirrorEdit(x, y);
  } else if (shapeStart) {
    const [x1, y1] = shapeStart;
    shapePreview = { k: 'shape', shape: tool, x1, y1, x2: x, y2: y, color, size: cfg[tool].size, op: opacityOf(tool), f: fillShapes, ...mirrorForOp() };
    compose();
  } else if (mirrorDrag) {
    mirrorDrag.line = snapLine(mirrorDrag.x0, mirrorDrag.y0, x, y); compose();
  } else if (eyeDrag) pickColourAt(x, y);
});

function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  const wasPinch = !!pinch;
  pointers.delete(e.pointerId);
  if (wasPinch) { if (pointers.size < 2) pinch = null; return; }
  const [x, y] = pos(e);
  if (pending) { clearTimeout(pending.timer); beginStroke(pending.x, pending.y, pending.pr); pending = null; }
  if (curOp) finishStroke(x, y, pressureOf(e));
  if (shapeEdit) endShapeEdit();
  if (mirrorEdit) { mirrorEdit = null; updateMirrorUI(); compose(); }
  if (shapeStart) {
    const [sx0, sy0] = shapeStart, pv = shapePreview; shapeStart = null; shapePreview = null;
    if (Math.hypot(x - sx0, y - sy0) <= 10 / screenScale()) { selShape = hitShape(x, y)?.id || null; compose(); }   // a tap: select (or deselect)
    else if (pv && Math.hypot(pv.x2 - pv.x1, pv.y2 - pv.y1) > 3 && layerById(activeLayer)?.visible) { const op = { id: newId(), l: activeLayer, ...pv }; addOp(op); selShape = op.id; }
    else compose();
  }
  if (eyeDrag) { eyeDrag = false; setTool(prevTool === 'eyedrop' ? 'pen' : prevTool); }
  if (mirrorDrag) { const md = mirrorDrag; mirrorDrag = null; finishMirrorDrag(md, x, y); }
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);

function beginPinch() {
  // a second finger turns whatever was starting into a zoom/pan gesture
  if (pending) { clearTimeout(pending.timer); pending = null; }
  if (curOp) finishStroke();
  shapeStart = null; shapePreview = null; eyeDrag = false; mirrorDrag = null; shapeEdit = null; mirrorEdit = null;
  const [a, b] = [...pointers.values()];
  const r = wrap.getBoundingClientRect();
  pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, s0: view.s, tx0: view.tx, ty0: view.ty, cx: r.left + r.width / 2 - view.tx, cy: r.top + r.height / 2 - view.ty };
  compose();
}
function movePinch() {
  const [a, b] = [...pointers.values()];
  const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const s = Math.min(8, Math.max(0.5, (pinch.s0 * d) / pinch.d0));
  // keep the point that was under the fingers under the fingers
  const qx = (pinch.mx - pinch.cx - pinch.tx0) / pinch.s0, qy = (pinch.my - pinch.cy - pinch.ty0) / pinch.s0;
  view.s = s; view.tx = mx - pinch.cx - s * qx; view.ty = my - pinch.cy - s * qy;
  applyView();
}
stage.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false }); // the page itself must never scroll or swipe away while drawing
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = wrap.getBoundingClientRect(), cx = r.left + r.width / 2 - view.tx, cy = r.top + r.height / 2 - view.ty;
  const s = Math.min(8, Math.max(0.5, view.s * Math.exp(-e.deltaY * 0.0015)));
  const qx = (e.clientX - cx - view.tx) / view.s, qy = (e.clientY - cy - view.ty) / view.s;
  view.s = s; view.tx = e.clientX - cx - s * qx; view.ty = e.clientY - cy - s * qy;
  applyView();
}, { passive: false });
$('#zoomReset').addEventListener('click', () => { view.s = 1; view.tx = view.ty = 0; view.rot = 0; fit(); applyView(); });
// turn the canvas a quarter turn so you can draw at whatever angle suits your hand
$('#rotateBtn').addEventListener('click', () => { view.rot = (view.rot + 1) % 4; view.s = 1; view.tx = view.ty = 0; fit(); applyView(); });

// ---------- layout ----------
function fit() {
  const turned = view.rot % 2 === 1;   // sideways, the picture's width is its height
  const k = Math.min((stage.clientWidth - 16) / (turned ? H : W), (stage.clientHeight - 16) / (turned ? W : H));
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
  if (id === 'eyedrop') prevTool = tool;
  if (!SHAPE_TOOLS.has(id)) selShape = null;
  if (id !== 'mirror') mirrorSel = -1;
  tool = id;
  document.querySelectorAll('.tool').forEach((x) => x.classList.toggle('on', x.dataset.tool === id));
  updateToolUI();
  updateMirrorUI();
  compose();
}

const sizeEl = $('#size'), opEl = $('#opacity');
function updateToolUI() {
  const sz = hasSize(tool), op = cfg[tool].op !== undefined;
  sizeEl.disabled = !sz; opEl.disabled = !op;
  sizeEl.max = TOOLS.find((t) => t.id === tool)?.max || 60;
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

// ----- mirror lines -----
// drag with the Mirror tool to place a dotted line; it snaps to straight or 45 degrees when you are close
function snapLine(x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
  if (len < 1) return [x0, y0, x1, y1];
  const ang = Math.atan2(dy, dx), step = Math.PI / 4, near = Math.round(ang / step) * step;
  if (Math.abs(ang - near) < (6 * Math.PI) / 180) return [x0, y0, x0 + Math.cos(near) * len, y0 + Math.sin(near) * len];
  return [x0, y0, x1, y1];
}
const distToLine = (px, py, [x1, y1, x2, y2]) => { const len = Math.hypot(x2 - x1, y2 - y1) || 1; return Math.abs((x2 - x1) * (y1 - py) - (x1 - px) * (y2 - y1)) / len; };
function addMirrorLine(l) {
  mirrorLines.push(l.map((n) => Math.round(n * 10) / 10));
  if (mirrorLines.length > 3) mirrorLines.shift();     // three lines (eight copies) is the most
  mirrorOn = true; updateMirrorUI(); compose();
}
function finishMirrorDrag(md) {
  const l = md.line;
  if (l && Math.hypot(l[2] - l[0], l[3] - l[1]) >= 60) { addMirrorLine(l); mirrorSel = mirrorLines.length - 1; updateMirrorUI(); return; }
  mirrorSel = -1; updateMirrorUI(); compose();      // a tap on empty space just lets go of the selected line
}
function updateMirrorUI() {
  const n = mirrorLines.length, on = mirrorOn && n > 0;
  $('#symBtn').textContent = on ? `⇋ Mirror: on (${n} line${n > 1 ? 's' : ''})` : '⇋ Mirror: off';
  $('#symBtn').classList.toggle('on', on);
  $('#mirbar').hidden = tool !== 'mirror';
  $('#mirDel').disabled = !n; $('#mirClear').disabled = !n;
  $('#mirDel').textContent = mirrorSel >= 0 ? 'Delete this line' : 'Delete last line';
}
$('#symBtn').addEventListener('click', () => {
  if (!mirrorLines.length) { addMirrorLine([W / 2, 0, W / 2, H]); toast('Mirror line added in the middle. Use the Mirror tool to place your own'); return; }
  mirrorOn = !mirrorOn; updateMirrorUI(); compose();
});
$('#mirV').addEventListener('click', () => addMirrorLine([W / 2, 0, W / 2, H]));
$('#mirH').addEventListener('click', () => addMirrorLine([0, H / 2, W, H / 2]));
$('#mirDel').addEventListener('click', () => {
  const i = mirrorSel >= 0 ? mirrorSel : mirrorLines.length - 1;
  if (i < 0) return;
  mirrorLines.splice(i, 1); mirrorSel = -1; if (!mirrorLines.length) mirrorOn = false;
  updateMirrorUI(); compose();
});
$('#mirClear').addEventListener('click', () => { mirrorLines = []; mirrorSel = -1; mirrorOn = false; updateMirrorUI(); compose(); });
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

// ----- people asking to join a closed drawing -----
const joinBar = $('#joinbar');
function addJoinReq(u) {
  if (joinBar.querySelector(`[data-id="${u.id}"]`)) return;
  const row = document.createElement('div');
  row.className = 'jrow'; row.dataset.id = u.id;
  row.innerHTML = '<span class="jname"></span><button class="primary" data-ok="1">Let in</button><button data-ok="0">Decline</button>';
  row.querySelector('.jname').textContent = `${u.name} wants to join`;
  row.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    send({ t: 'admit', id: u.id, ok: b.dataset.ok === '1' });
    removeJoinReq(u.id);
  });
  joinBar.appendChild(row); joinBar.hidden = false;
}
function removeJoinReq(id) {
  joinBar.querySelector(`[data-id="${id}"]`)?.remove();
  joinBar.hidden = !joinBar.children.length;
}

// ----- inviting people -----
const isheet = $('#isheet');
$('#inviteBtn').hidden = mode !== 'together';
$('#inviteBtn').addEventListener('click', () => {
  if (!inviteLink) return toast('The invite link is not ready yet');
  $('#inviteText').textContent = policy === 'c'
    ? '🔒 This drawing is closed: people you invite ask to join, and someone drawing lets them in.'
    : '🔓 This drawing is open: anyone who gets the link can join.';
  isheet.classList.add('show');
});
isheet.addEventListener('click', async (e) => {
  const act = e.target.dataset.act;
  if (e.target === isheet || act === 'done') return isheet.classList.remove('show');
  if (act === 'share') {
    const text = policy === 'c' ? 'Come draw with me on ScribbleJam! (someone drawing will let you in)' : 'Come draw with me on ScribbleJam!';
    const url = `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent(text)}`;
    isheet.classList.remove('show');
    if (tg?.openTelegramLink) tg.openTelegramLink(url); else window.open(url, '_blank');
  } else if (act === 'copy') {
    isheet.classList.remove('show');
    try { await navigator.clipboard.writeText(inviteLink); toast('Invite link copied'); }
    catch { await ask({ title: 'Copy this link', input: inviteLink, ok: 'Done' }); }
  }
});

// ----- undo / redo / clear -----
$('#undo').addEventListener('click', undo);
$('#redo').addEventListener('click', redo);
$('#clearBtn').addEventListener('click', async () => {
  $('#csheet').classList.remove('show');
  if (!(await ask({ title: 'Clear everything?', text: mode === 'together' ? 'This wipes the whole drawing, on every layer, for everyone.' : 'This wipes the whole drawing, on every layer.', ok: 'Clear' }))) return;
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
    const L = { id: newId().slice(0, 6), name: `Layer ${layers.length + 1}`, visible: true, opacity: 1, blend: 'source-over' };
    layers.push(L); activeLayer = L.id; lcanvas(L.id);
    if (mode === 'together') send({ t: 'layer', act: 'add', layer: L, at: layers.length - 1 });
    return renderLayersUI();
  }
  if (!row || !a) return;
  const L = layerById(row.dataset.id), i = layers.indexOf(L);
  if (a === 'pick') { if (activeLayer === L.id) { const n = await ask({ title: 'Layer name', input: L.name, ok: 'Save' }); if (n?.trim()) layerChanged(L, { name: n.trim().slice(0, 20) }); } else { activeLayer = L.id; } }
  else if (a === 'eye') layerChanged(L, { visible: !L.visible });
  else if (a === 'up' || a === 'down') {
    const j = a === 'up' ? i + 1 : i - 1;
    if (j < 0 || j >= layers.length) return;
    [layers[i], layers[j]] = [layers[j], layers[i]];
    if (mode === 'together') send({ t: 'layer', act: 'order', ids: layers.map((x) => x.id) });
    compose();
  } else if (a === 'del') {
    if (layers.length < 2 || !(await ask({ title: 'Delete layer?', text: `"${L.name}" and everything drawn on it will be removed.`, ok: 'Delete' }))) return;
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
if (mode === 'solo' && savedDrawing) {
  ops.push(...savedDrawing.ops); layers = savedDrawing.layers; ensureActive();
  setBg(savedDrawing.bg || '#ffffff', false);
  if (PRESETS[savedDrawing.size]) { sizeKey = savedDrawing.size; [W, H] = PRESETS[sizeKey]; document.querySelectorAll('.csize').forEach((b) => b.classList.toggle('sel', b.dataset.size === sizeKey)); }
  setTimeout(() => toast('Welcome back - your drawing was saved'), 400);
}
if (mode === 'solo') saveEnabled = true;
cv.width = W; cv.height = H; ov.width = W; ov.height = H;
fit();
document.querySelector('.tool[data-tool=pen]').classList.add('on');
uiReady = true;
setColor(color);
updateToolUI();
updateMirrorUI();
renderLayersUI();
renderAll();

// everything must be on the layers (and the composite up to date) before a picture is made
function prepareForExport() {
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
  connect(); // the splash stays until the server lets us in (see hideBoot, called on 'init')
  setTimeout(() => { if (gate === 'connecting') { bootNote('Still trying to connect…'); $('#bootRetry').hidden = false; } }, 20000);
}
let gate = 'connecting'; // connecting -> waiting (closed room) -> in
function hideBoot() { gate = 'in'; boot.classList.add('out'); setTimeout(() => boot.classList.remove('show', 'out'), 400); }
// a message on the splash, with a Close button when there is nothing more to wait for
function bootNote(text, closable = false) {
  if (closable && text.startsWith('🔒')) gate = 'waiting';
  boot.classList.remove('out'); boot.classList.add('show');
  $('#bootmsg').textContent = text; $('#bootRetry').hidden = true; $('#bootClose').hidden = !closable;
}
$('#bootClose').addEventListener('click', () => { if (tg?.close) tg.close(); else history.back(); });
$('#bootRetry').addEventListener('click', () => { ready = ping().then((ok) => (serverUp = ok)); start(); });
start();
