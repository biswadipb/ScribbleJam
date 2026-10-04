const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const $ = (s) => document.querySelector(s);
const API = (window.SJ_API || '').replace(/\/$/, ''); // '' = same server as this page
// Canvas presets (max side 1024). 'square' is the standard size.
const PRESETS = { square: [1024, 1024], portrait: [768, 1024], landscape: [1024, 768], wide: [1024, 576], story: [576, 1024] };
let sizeKey = 'square';
let [W, H] = PRESETS.square;
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
let bg = '#ffffff'; // canvas colour: a hex colour, or 'transparent'
let tool = 'pencil';
let color = '#000000';
const sizes = { pencil: 6, pen: 8, brush: 16, eraser: 24 }; // each tool remembers its own size
let size = sizes.pencil;
let ws = null;
let uiReady = false; // set once the toolbar exists

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
  x0 = Math.max(0, Math.min(W - 1, Math.round(x0)));
  y0 = Math.max(0, Math.min(H - 1, Math.round(y0)));
  const img = ctx.getImageData(0, 0, W, H), d = img.data;
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
  ctx.putImageData(img, 0, 0);
}

function applyOp(op) {
  if (op.k === 'fill') floodFill(op.x, op.y, op.color);
  else paintStroke(op);
}

function renderAll() {
  ctx.clearRect(0, 0, W, H);
  for (const op of ops) { op._n = 0; applyOp(op); }
}

// ---------- networking ----------
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }

function connect() {
  const base = new URL(API || location.origin);
  const proto = base.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${base.host}/ws?token=${token}&initData=${encodeURIComponent(initData)}`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'init') { ops.length = 0; ops.push(...m.ops); setBg(m.bg, false); setCanvasSize(m.size || 'square', false); renderAll(); peers(m.peers); }
    else if (m.t === 'op') { ops.push(m.op); applyOp(m.op); }
    else if (m.t === 'pts') { const o = ops.find((o) => o.id === m.id); if (o) { o.pts.push(...m.pts); paintStroke(o); } }
    else if (m.t === 'remove') { const i = ops.findIndex((o) => o.id === m.id); if (i >= 0) { ops.splice(i, 1); renderAll(); } }
    else if (m.t === 'clear') { ops.length = 0; renderAll(); }
    else if (m.t === 'bg') setBg(m.bg, false);
    else if (m.t === 'size') setCanvasSize(m.size, false);
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
  return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
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
  const k = Math.min((st.clientWidth - 16) / W, (st.clientHeight - 16) / H);
  wrap.style.width = Math.max(100, Math.floor(W * k)) + 'px';
  wrap.style.height = Math.max(100, Math.floor(H * k)) + 'px';
  if (uiReady) showSize();
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
  if (uiReady) showSize();
}

const sizeEl = $('#size');
function showSize() {
  const fill = tool === 'fill';
  sizeEl.disabled = fill;
  sizeEl.value = size;
  $('#sizeLabel').textContent = fill ? 'Bucket has no size' : `${tool} size ${size}`;
  // preview dot = real on-screen thickness of the stroke
  const px = fill ? 6 : widthOf(tool, size) * (wrap.clientWidth / W);
  const d = Math.max(2, Math.min(34, px));
  $('#dot i').style.width = $('#dot i').style.height = d + 'px';
  $('#dot i').style.background = tool === 'eraser' ? 'transparent' : color;
  $('#dot i').style.border = tool === 'eraser' ? '2px dashed var(--hint)' : '0';
}
sizeEl.addEventListener('input', () => { size = sizes[tool] = +sizeEl.value; showSize(); });
showSize();
uiReady = true;
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
  if (v === 'white') v = '#ffffff';
  bg = v;
  wrap.classList.toggle('transparent', v === 'transparent');
  wrap.style.backgroundColor = v === 'transparent' ? '' : v;
  document.querySelectorAll('.csw').forEach((b) => b.classList.toggle('sel', b.dataset.c === v));
  if (announce && mode === 'together') send({ t: 'bg', bg: v });
}

function setCanvasSize(key, announce = true) {
  if (!PRESETS[key]) return;
  sizeKey = key;
  [W, H] = PRESETS[key];
  cv.width = W; cv.height = H; // resizing clears the bitmap, so redraw everything
  document.querySelectorAll('.csize').forEach((b) => b.classList.toggle('sel', b.dataset.size === key));
  fit();
  renderAll();
  if (announce && mode === 'together') send({ t: 'size', size: key });
}

// ---- canvas settings sheet (size + colour) ----
const csheet = $('#csheet');
$('#bg').addEventListener('click', () => csheet.classList.add('show'));
csheet.addEventListener('click', (e) => { if (e.target === csheet || e.target.dataset.act === 'done') csheet.classList.remove('show'); });

document.querySelectorAll('.csize').forEach((b) => b.addEventListener('click', () => {
  const key = b.dataset.size;
  if (key === sizeKey) return;
  if (ops.length && !confirm((mode === 'together' ? 'Everyone will get a new canvas size. ' : '') + 'Parts of the drawing outside the new size will be cropped. Continue?')) return;
  setCanvasSize(key);
}));

const cpal = $('#cpalette');
['#ffffff', '#fffdf6', '#fde68a', '#fecaca', '#bfdbfe', '#bbf7d0', '#e9d5ff', '#d1d5db', '#6b7280', '#22223b', '#111111'].forEach((c) => {
  const b = document.createElement('button');
  b.className = 'sw csw'; b.style.background = c; b.dataset.c = c;
  b.addEventListener('click', () => setBg(c));
  cpal.appendChild(b);
});
const clear = document.createElement('button');
clear.className = 'sw csw checker'; clear.dataset.c = 'transparent'; clear.title = 'No background (transparent)';
clear.addEventListener('click', () => setBg('transparent'));
cpal.appendChild(clear);
const ccustom = document.createElement('div');
ccustom.className = 'sw custom';
ccustom.innerHTML = '<input type="color" value="#ffffff">';
ccustom.querySelector('input').addEventListener('input', (e) => setBg(e.target.value));
cpal.appendChild(ccustom);
setBg(bg, false);
document.querySelector('.csize[data-size=square]').classList.add('sel');

// ---------- export ----------
const me = tg?.initDataUnsafe?.user;
const myName = me ? [me.first_name, me.last_name].filter(Boolean).join(' ') || me.username || 'Someone' : 'Someone';

// Names of everyone who drew (shared room) or just you (alone).
async function artistNames() {
  if (mode !== 'together') return [myName];
  try {
    if (!serverUp) await ready;
    const r = await fetch(`${API}/api/artists`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData, token, mode }),
    });
    const j = await r.json();
    if (r.ok && j.names?.length) return j.names;
  } catch {}
  return [myName];
}

function joinNames(names, max = 3) {
  const list = names.length > max ? [...names.slice(0, max), `${names.length - max} more`] : names;
  return list.length < 2 ? list[0] : `${list.slice(0, -1).join(', ')} & ${list.at(-1)}`;
}
const tagLine = (names) => `Drawn with ScribbleJam by ${joinNames(names)}`;

// Small unobtrusive credit in the bottom-right corner, like a saved-image watermark.
function drawTag(c, w, h, names) {
  let fs = Math.max(11, Math.round(Math.min(w, h) * 0.028));
  const maxW = w * 0.72;
  let text = tagLine(names);
  const setFont = () => (c.font = `600 ${fs}px system-ui, -apple-system, "Segoe UI", sans-serif`);
  setFont();
  while (c.measureText(text).width > maxW && fs > 9) { fs -= 1; setFont(); }
  while (c.measureText(text).width > maxW && text.length > 12) text = text.slice(0, -2).trimEnd() + '…';
  const padX = fs * 0.7, padY = fs * 0.45, m = fs * 0.9;
  const bw = c.measureText(text).width + padX * 2, bh = fs + padY * 2;
  const x = w - m - bw, y = h - m - bh, r = bh / 2;
  c.save();
  c.fillStyle = 'rgba(20,20,40,0.55)';
  c.beginPath();
  c.moveTo(x + r, y); c.arcTo(x + bw, y, x + bw, y + bh, r); c.arcTo(x + bw, y + bh, x, y + bh, r);
  c.arcTo(x, y + bh, x, y, r); c.arcTo(x, y, x + bw, y, r); c.closePath(); c.fill();
  c.fillStyle = 'rgba(255,255,255,0.95)';
  c.textBaseline = 'middle';
  c.fillText(text, x + padX, y + bh / 2 + fs * 0.04);
  c.restore();
}

// scale: 1 = full canvas; background: a colour or null for transparent; names: adds the credit tag.
function exportImage(scale, background, names = null, type = 'image/png') {
  const out = document.createElement('canvas');
  out.width = Math.round(W * scale); out.height = Math.round(H * scale);
  const c = out.getContext('2d');
  if (background) { c.fillStyle = background; c.fillRect(0, 0, out.width, out.height); }
  c.drawImage(cv, 0, 0, out.width, out.height);
  if (names) drawTag(c, out.width, out.height, names);
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

async function shareToApps(names) {
  const blob = await (await fetch(exportImage(1, keepBg(), names))).blob();
  const file = new File([blob], 'ScribbleJam.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], text: names ? tagLine(names) : 'Drawn with ScribbleJam' }); }
    catch (e) { if (e.name !== 'AbortError') throw e; }
    return;
  }
  toast('Sharing is not available here - saving instead');
  await saveImage(names);
}

const sheet = $('#sheet');
let namesP = Promise.resolve([myName]);
$('#share').addEventListener('click', () => { namesP = artistNames(); sheet.classList.add('show'); });
sheet.addEventListener('click', async (e) => {
  if (e.target === sheet) return sheet.classList.remove('show');
  if (e.target.closest('label')) return; // the credit-tag checkbox
  const act = e.target.closest('button')?.dataset.act;
  if (!act) return;
  sheet.classList.remove('show');
  if (act === 'close') return;
  try {
    const names = $('#tagToggle').checked && !act.startsWith('sticker') ? await namesP : null;
    if (act === 'print') {
      await api('print', exportImage(1, keepBg(), names), { bg: bg === 'transparent' ? 'transparent' : 'solid' });
      toast('Sent to the chat 🎉');
    } else if (act === 'forward') {
      if (!(tg?.shareMessage && tg.isVersionAtLeast?.('8.0'))) { toast('Update Telegram to send to other chats - sharing to apps instead'); return shareToApps(names); }
      const { id } = await api('prepare', exportImage(1, solidBg(), names, 'image/jpeg'), { w: W, h: H });
      tg.shareMessage(id, (ok) => ok && toast('Shared ✅'));
    } else if (act === 'apps') {
      await shareToApps(names);
    } else if (act === 'save') {
      await saveImage(names);
    } else if (act === 'story') {
      const { url } = await api('story', exportImage(1, solidBg(), names));
      if (tg?.shareToStory && tg.isVersionAtLeast?.('7.8')) tg.shareToStory(url, { text: names ? tagLine(names) : '🎨' });
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
const MSGS = ['Sharpening pencils…', 'Mixing the colours…', 'Warming up the canvas…', 'Waking the server up (it naps when quiet)…', 'Almost there…'];

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
  let n = 0;
  const msgTimer = setInterval(() => { $('#bootmsg').textContent = MSGS[Math.min(++n, MSGS.length - 1)]; }, 2600);
  const ok = await ready;
  clearInterval(msgTimer);
  if (!ok) { $('#bootmsg').textContent = 'The server is taking a long nap 😴'; $('#bootRetry').hidden = false; return; }
  connect();
  boot.classList.add('out'); setTimeout(() => boot.classList.remove('show', 'out'), 400);
}
$('#bootRetry').addEventListener('click', () => { ready = ping().then((ok) => (serverUp = ok)); start(); });
start();
