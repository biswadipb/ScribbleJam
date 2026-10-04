const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const $ = (s) => document.querySelector(s);
const S = 1024; // logical canvas size
const cv = $('#cv');
const ctx = cv.getContext('2d', { willReadFrequently: true });

// ---------- session ----------
// start_param looks like "t_<token>" (together) or "s_<token>" (alone).
// For local testing outside Telegram: /?p=t_abc
const param = tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('p') || 's_dev';
const mode = param[0] === 't' ? 'together' : 'solo';
const token = param.slice(2);
const initData = tg?.initData || 'dev';
$('#mode').textContent = mode === 'together' ? '👥 together' : '✏️ alone';

// ---------- state ----------
const ops = [];
let bg = 'white';
let tool = 'pencil';
let color = '#000000';
const sizes = { pencil: 6, pen: 8, brush: 16, eraser: 24 }; // each tool remembers its own size
let size = sizes.pencil;
let ws = null;

const COLORS = ['#000000', '#ffffff', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#00acc1', '#1e88e5', '#5e35b1', '#d81b60', '#8d6e63', '#9e9e9e'];

// ---------- rendering ----------
function widthOf(t, sz) {
  if (t === 'pencil') return Math.max(1, sz * 0.5);
  if (t === 'brush') return sz * 1.8;
  return sz; // pen, eraser
}

function style(op) {
  ctx.lineCap = ctx.lineJoin = 'round';
  ctx.strokeStyle = ctx.shadowColor = op.color;
  ctx.shadowBlur = 0;
  ctx.globalCompositeOperation = 'source-over';
  const w = widthOf(op.tool, op.size);
  if (op.tool === 'brush') ctx.shadowBlur = w * 0.4;
  if (op.tool === 'eraser') ctx.globalCompositeOperation = 'destination-out';
  ctx.lineWidth = w;
}

function paintStroke(op) {
  const p = op.pts, n = p.length / 2;
  let i = op._n || 0;
  if (i >= n) return;
  ctx.save();
  style(op);
  ctx.beginPath();
  if (i === 0) { ctx.moveTo(p[0], p[1]); ctx.lineTo(p[0], p[1]); i = 1; }
  else ctx.moveTo(p[2 * (i - 1)], p[2 * (i - 1) + 1]);
  for (; i < n; i++) ctx.lineTo(p[2 * i], p[2 * i + 1]);
  ctx.stroke();
  ctx.restore();
  op._n = n;
}

function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }

// Deterministic so every participant ends up with the same pixels.
function floodFill(x0, y0, hex) {
  x0 = Math.max(0, Math.min(S - 1, Math.round(x0)));
  y0 = Math.max(0, Math.min(S - 1, Math.round(y0)));
  const img = ctx.getImageData(0, 0, S, S), d = img.data;
  const t = (y0 * S + x0) * 4;
  const tr = d[t], tg_ = d[t + 1], tb = d[t + 2], ta = d[t + 3];
  const [fr, fg, fb] = hexToRgb(hex);
  const clear = ta < 10;
  const match = (i) => clear
    ? d[i + 3] <= 150
    : Math.abs(d[i] - tr) + Math.abs(d[i + 1] - tg_) + Math.abs(d[i + 2] - tb) + Math.abs(d[i + 3] - ta) <= 60;
  const seen = new Uint8Array(S * S);
  const stack = [y0 * S + x0];
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
    const x = pi % S;
    if (x > 0) stack.push(pi - 1);
    if (x < S - 1) stack.push(pi + 1);
    if (pi >= S) stack.push(pi - S);
    if (pi < S * (S - 1)) stack.push(pi + S);
  }
  ctx.putImageData(img, 0, 0);
}

function applyOp(op) {
  if (op.k === 'fill') floodFill(op.x, op.y, op.color);
  else paintStroke(op);
}

function renderAll() {
  ctx.clearRect(0, 0, S, S);
  for (const op of ops) { op._n = 0; applyOp(op); }
}

// ---------- networking ----------
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${token}&initData=${encodeURIComponent(initData)}`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'init') { ops.length = 0; ops.push(...m.ops); setBg(m.bg, false); renderAll(); peers(m.peers); }
    else if (m.t === 'op') { ops.push(m.op); applyOp(m.op); }
    else if (m.t === 'pts') { const o = ops.find((o) => o.id === m.id); if (o) { o.pts.push(...m.pts); paintStroke(o); } }
    else if (m.t === 'remove') { const i = ops.findIndex((o) => o.id === m.id); if (i >= 0) { ops.splice(i, 1); renderAll(); } }
    else if (m.t === 'clear') { ops.length = 0; renderAll(); }
    else if (m.t === 'bg') setBg(m.bg, false);
    else if (m.t === 'peers') peers(m.n);
  };
  ws.onclose = () => { toast('Disconnected - reconnecting…'); setTimeout(connect, 1500); };
}
function peers(n) { $('#mode').textContent = `👥 ${n} drawing`; }

// ---------- input ----------
const wrap = $('#wrap');
let cur = null, buf = [], flushTimer = null;

function pos(e) {
  const r = cv.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * S, ((e.clientY - r.top) / r.height) * S];
}
const newId = () => Math.random().toString(36).slice(2, 10);

function flush() {
  flushTimer = null;
  if (cur && buf.length) { send({ t: 'pts', id: cur.id, pts: buf }); buf = []; }
}

wrap.addEventListener('pointerdown', (e) => {
  if (e.button > 0 || cur) return;
  e.preventDefault();
  const [x, y] = pos(e);
  if (tool === 'fill') {
    const op = { id: newId(), k: 'fill', x, y, color };
    ops.push(op); applyOp(op); send({ t: 'op', op });
    return;
  }
  wrap.setPointerCapture(e.pointerId);
  cur = { id: newId(), k: 'stroke', tool, color, size, pts: [x, y] };
  ops.push(cur); paintStroke(cur);
  send({ t: 'op', op: { ...cur, _n: undefined } });
});

wrap.addEventListener('pointermove', (e) => {
  if (!cur) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of evs.length ? evs : [e]) {
    const [x, y] = pos(ev);
    cur.pts.push(x, y); buf.push(x, y);
  }
  paintStroke(cur);
  if (!flushTimer) flushTimer = setTimeout(flush, 40);
});

const end = () => { if (cur) { flush(); cur = null; } };
wrap.addEventListener('pointerup', end);
wrap.addEventListener('pointercancel', end);

// ---------- layout ----------
function fit() {
  const st = $('#stage');
  const s = Math.floor(Math.min(st.clientWidth, st.clientHeight) - 16);
  wrap.style.width = wrap.style.height = Math.max(120, s) + 'px';
}
addEventListener('resize', fit);
new ResizeObserver(fit).observe($('#stage'));
fit();

// ---------- toolbar ----------
document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => {
  tool = b.dataset.tool;
  if (sizes[tool]) size = sizes[tool];
  document.querySelectorAll('.tool').forEach((x) => x.classList.toggle('on', x === b));
  showSize();
}));

const pal = $('#palette');
COLORS.forEach((c) => {
  const b = document.createElement('button');
  b.className = 'sw'; b.style.background = c; b.dataset.c = c;
  b.addEventListener('click', () => setColor(c));
  pal.appendChild(b);
});
const custom = document.createElement('div');
custom.className = 'sw custom';
custom.innerHTML = '<input type="color" value="#ff8800">';
custom.querySelector('input').addEventListener('input', (e) => setColor(e.target.value));
pal.appendChild(custom);

function setColor(c) {
  color = c;
  document.querySelectorAll('.sw').forEach((b) => b.classList.toggle('sel', b.dataset.c === c));
  if (typeof showSize === 'function' && sizeEl) showSize();
}

const sizeEl = $('#size');
function showSize() {
  const fill = tool === 'fill';
  sizeEl.disabled = fill;
  sizeEl.value = size;
  $('#sizeLabel').textContent = fill ? 'Bucket has no size' : `${tool} size ${size}`;
  // preview dot = real on-screen thickness of the stroke
  const px = fill ? 6 : widthOf(tool, size) * (wrap.clientWidth / S);
  const d = Math.max(2, Math.min(34, px));
  $('#dot i').style.width = $('#dot i').style.height = d + 'px';
  $('#dot i').style.background = tool === 'eraser' ? 'transparent' : color;
  $('#dot i').style.border = tool === 'eraser' ? '2px dashed var(--hint)' : '0';
}
sizeEl.addEventListener('input', () => { size = sizes[tool] = +sizeEl.value; showSize(); });
showSize();
setColor(color);

$('#undo').addEventListener('click', () => {
  if (mode === 'together') return send({ t: 'undo' });
  if (ops.length) { ops.pop(); renderAll(); }
});
$('#clear').addEventListener('click', () => {
  if (!confirm(mode === 'together' ? 'Clear the drawing for everyone?' : 'Clear the drawing?')) return;
  if (mode === 'together') send({ t: 'clear' }); else { ops.length = 0; renderAll(); }
});

function setBg(v, announce = true) {
  bg = v;
  wrap.classList.toggle('transparent', v === 'transparent');
  $('#bg').textContent = v === 'white' ? '⬜ White' : '🔳 Clear';
  if (announce && mode === 'together') send({ t: 'bg', bg: v });
}
$('#bg').addEventListener('click', () => setBg(bg === 'white' ? 'transparent' : 'white'));

// ---------- export ----------
function exportPng(size, withBg) {
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const c = out.getContext('2d');
  if (withBg) { c.fillStyle = '#fff'; c.fillRect(0, 0, size, size); }
  c.drawImage(cv, 0, 0, size, size);
  return out.toDataURL('image/png');
}

async function api(action, png, extra = {}) {
  const r = await fetch('/api/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ initData, token, mode, action, png, ...extra }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}

const sheet = $('#sheet');
$('#share').addEventListener('click', () => sheet.classList.add('show'));
sheet.addEventListener('click', async (e) => {
  if (e.target === sheet) return sheet.classList.remove('show');
  const act = e.target.closest('button')?.dataset.act;
  if (!act) return;
  sheet.classList.remove('show');
  if (act === 'close') return;
  try {
    if (act === 'print') {
      await api('print', exportPng(1024, bg === 'white'), { bg });
      toast('Sent to the chat 🎉');
    } else if (act === 'story') {
      const { url } = await api('story', exportPng(1024, true));
      if (tg?.shareToStory && tg.isVersionAtLeast?.('7.8')) tg.shareToStory(url, { text: '🎨' });
      else toast('Your Telegram is too old for stories - please update it');
    } else {
      const { link } = await api('sticker', exportPng(512, act === 'sticker-white'));
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

if (mode === 'together') connect();
