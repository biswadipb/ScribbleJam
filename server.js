import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Bot, InputFile, webhookCallback } from 'grammy';
import { WebSocketServer } from 'ws';

const { BOT_TOKEN, PUBLIC_URL, MINIAPP_SHORT, PORT = 3000, DEV } = process.env;
if (!BOT_TOKEN && !DEV) {
  console.error('BOT_TOKEN is required (or set DEV=1 to run without Telegram)');
  process.exit(1);
}

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs');
const MAX_OPS = 3000;
const SIZES = new Set(['square', 'portrait', 'landscape', 'wide', 'story']);
const MAX_PTS = 20000; // numbers per stroke

// Session tokens are signed and self-contained ("<chat>x<nonce>x<sig>"), so they keep working
// after Render restarts the service. Only the live canvas (rooms) is held in memory.
const sign = (s) => crypto.createHmac('sha256', BOT_TOKEN || 'dev').update(s).digest('base64url').slice(0, 10);
function makeToken(chatId) {
  const body = `${String(chatId).replace('-', 'n')}x${rand(4)}`;
  return `${body}x${sign(body)}`;
}
function getSession(token) {
  const m = /^((n?\d+)x[0-9a-f]{8})x([A-Za-z0-9_-]{10})$/.exec(token || '');
  if (!m || sign(m[1]) !== m[3]) return DEV && token ? { chatId: 0 } : null;
  return { chatId: Number(m[2].replace('n', '-')) };
}
// token -> { ops, bg, clients:Set }
const rooms = new Map();
// id -> { buf, exp }  short-lived PNGs for story sharing
const images = new Map();

const rand = (n = 6) => crypto.randomBytes(n).toString('hex');

// ---------- Telegram initData verification ----------
function verifyInitData(initData) {
  if (DEV && initData === 'dev') return { id: 1, first_name: 'Dev' };
  if (DEV && initData?.startsWith('dev:')) { // test helper: "dev:<id>:<first name>[:<username>]"
    const [, id, first_name, username] = initData.split(':');
    return { id: Number(id), first_name, ...(username ? { username } : {}) };
  }
  if (!initData || !BOT_TOKEN) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const str = [...p.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  const a = Buffer.from(calc), b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch { return null; }
}

// ---------- Bot ----------
const bot = BOT_TOKEN ? new Bot(BOT_TOKEN) : null;
// In DEV (no token) sends are just logged, so the Finish flow can be tested without Telegram.
const tgApi = bot ? bot.api : DEV ? {
  sendPhoto: async (chat, _f, o) => console.log('DEV sendPhoto', JSON.stringify(o.caption)),
  sendDocument: async (chat, _f, o) => console.log('DEV sendDocument', JSON.stringify(o.caption)),
} : null;

// Where the Mini App page lives (GitHub Pages never sleeps). Private chats open it with a web_app
// button, which has no sleepy-server wait and no choice to make: a DM is always a one-person canvas.
const WEBAPP_URL = (process.env.WEBAPP_URL || 'https://biswadipb.github.io/ScribbleJam/').replace(/\/?$/, '/');

async function sendDrawPrompt(ctx) {
  if (ctx.chat.type === 'private') {
    await ctx.reply('🎨 Tap to start drawing. When you finish, the picture comes back to this chat.', {
      reply_markup: { inline_keyboard: [[{ text: '🎨 Start drawing', web_app: { url: `${WEBAPP_URL}?p=s_me` } }]] },
    });
    return;
  }
  // groups: choose between drawing alone or together
  const token = makeToken(ctx.chat.id);
  const link = (m) => `https://t.me/${bot.botInfo.username}/${MINIAPP_SHORT}?startapp=${m}_${token}`;
  await ctx.reply('🎨 How do you want to draw?', {
    reply_markup: {
      inline_keyboard: [[
        { text: '✏️ Draw alone', url: link('s') },
        { text: '👥 Draw together', url: link('t') },
      ]],
    },
  });
}

if (bot) {
  bot.command(['draw', 'start'], sendDrawPrompt);
  // in a DM, any message gets the drawing button (people don't always know to type /draw)
  bot.on('message', (ctx) => (ctx.chat.type === 'private' ? sendDrawPrompt(ctx) : undefined));
}

// ---------- Captions ----------
const realName = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ');

// How to tag someone: @username if they have one; otherwise their name (as a real clickable mention);
// otherwise, in the rare case there is no name either, their user id (also a real mention).
function mentionOf(u) {
  if (u.username) return { text: `@${u.username}` };
  const name = realName(u);
  return { text: name || `User ${u.id}`, userId: u.id, first_name: u.first_name || name || `User ${u.id}` };
}

// Everyone who drew in a shared room; otherwise just the person who finished it.
function artists(token, finisher, mode) {
  const room = mode === 'together' ? rooms.get(token) : null;
  const list = room ? [...new Set(room.ops.map((o) => o.u))].map((id) => room.users.get(id)).filter(Boolean) : [];
  return list.length ? list : [finisher];
}

// "Drawn by @a, Sam and User 42" plus entities so people without a username are still tagged.
function doodleCaption(users) {
  const parts = users.map(mentionOf);
  let caption = 'Drawn by ';
  const entities = [];
  parts.forEach((p, i) => {
    if (i > 0) caption += i === parts.length - 1 ? ' and ' : ', ';
    if (p.userId) entities.push({ type: 'text_mention', offset: caption.length, length: p.text.length, user: { id: p.userId, is_bot: false, first_name: p.first_name } });
    caption += p.text;
  });
  return { caption, entities };
}

// Full display name (no @) for the footer on the picture. Falls back to username, then the id.
const fullName = (u) => realName(u) || u.username || `User ${u.id}`;

// ---------- Export (print / story / sticker) ----------
async function handleExport(body) {
  const user = verifyInitData(body.initData);
  if (!user) return [401, { error: 'bad initData' }];
  const session = body.token === 'me' ? { chatId: user.id } : getSession(body.token);
  if (!session) return [410, { error: 'This drawing session expired. Send /draw again.' }];
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(body.png || '');
  if (!m) return [400, { error: 'image required' }];
  const buf = Buffer.from(m[2], 'base64');
  const isPng = buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47;
  const isJpeg = buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  // Telegram only accepts JPEG for photos shared through "send to another chat"
  if (body.action === 'prepare' ? !isJpeg : !isPng) return [400, { error: 'wrong image type' }];

  const name = user.first_name || 'Someone';

  if (body.action === 'print') {
    // In a shared room several people may press Finish: post each version of the drawing once.
    const room = body.mode === 'together' ? rooms.get(body.token) : null;
    if (room && room.posted === room.version) return [200, { ok: true, duplicate: true }];
    const sentVersion = room?.version;
    if (room) room.posted = sentVersion; // claim it first so a simultaneous Finish doesn't post twice
    const file = new InputFile(buf, 'drawing.png');
    const { caption, entities } = doodleCaption(artists(body.token, user, body.mode));
    try {
      if (body.bg === 'transparent') await tgApi.sendDocument(session.chatId, file, { caption, caption_entities: entities });
      else await tgApi.sendPhoto(session.chatId, file, { caption, caption_entities: entities });
    } catch (e) {
      if (room && room.posted === sentVersion) room.posted = -1;
      throw e;
    }
    return [200, { ok: true }];
  }

  // 'story' and 'host' just publish the image at a short-lived public URL (story sharing, downloads).
  if (body.action === 'story' || body.action === 'host') {
    const id = rand(8);
    images.set(id, { buf, type: 'image/png', exp: Date.now() + 30 * 60_000 });
    return [200, { url: `${PUBLIC_URL}/img/${id}.png` }];
  }

  // Lets the Mini App call Telegram's share dialog so the user can send the doodle to any chat.
  if (body.action === 'prepare') {
    const id = rand(8);
    images.set(id, { buf, type: 'image/jpeg', exp: Date.now() + 2 * 3600_000 });
    const url = `${PUBLIC_URL}/img/${id}.jpg`;
    const { caption, entities } = doodleCaption(artists(body.token, user, body.mode));
    const prepared = await bot.api.savePreparedInlineMessage(
      user.id,
      {
        type: 'photo', id: `sj${id}`, photo_url: url, thumbnail_url: url,
        photo_width: Number(body.w) || undefined, photo_height: Number(body.h) || undefined,
        caption, caption_entities: entities,
      },
      { allow_user_chats: true, allow_bot_chats: true, allow_group_chats: true, allow_channel_chats: true },
    );
    return [200, { id: prepared.id }];
  }

  if (body.action === 'sticker') {
    const setName = `d${user.id}_by_${bot.botInfo.username}`.toLowerCase();
    const sticker = { sticker: new InputFile(buf, 'sticker.png'), format: 'static', emoji_list: ['🎨'] };
    let exists = true;
    try { await bot.api.getStickerSet(setName); } catch { exists = false; }
    if (exists) await bot.api.addStickerToSet(user.id, setName, sticker);
    else await bot.api.createNewStickerSet(user.id, setName, `${name}'s ScribbleJam doodles`, [sticker]);
    return [200, { ok: true, link: `https://t.me/addstickers/${setName}` }];
  }

  return [400, { error: 'unknown action' }];
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const webhookSecret = BOT_TOKEN ? crypto.createHash('sha256').update(BOT_TOKEN).digest('hex').slice(0, 32) : '';
const tgHandler = bot ? webhookCallback(bot, 'http') : null;

function readJson(req, limit = 10_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // The Mini App page may be served from a static host (GitHub Pages) that calls this server.
  // Requests are authenticated by Telegram initData, not cookies, so open CORS is fine.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (req.method === 'POST' && tgHandler && url.pathname === `/tg/${webhookSecret}`) return tgHandler(req, res);

    if (req.method === 'POST' && url.pathname === '/api/artists') {
      let status = 200, out;
      try {
        const body = await readJson(req, 100_000);
        const user = verifyInitData(body.initData);
        if (!user || !(body.token === 'me' || getSession(body.token))) [status, out] = [401, { error: 'bad session' }];
        else { const list = artists(body.token, user, body.mode); out = { names: list.map(fullName), tags: list.map((u) => mentionOf(u).text) }; }
      } catch { [status, out] = [400, { error: 'bad request' }]; }
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out));
    }

    if (req.method === 'POST' && url.pathname === '/api/export') {
      let status, out;
      try { [status, out] = await handleExport(await readJson(req)); }
      catch (e) { console.error(e); [status, out] = [500, { error: e.description || e.message || 'failed' }]; }
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out));
    }

    const img = /^\/img\/([a-f0-9]+)\.(?:png|jpg)$/.exec(url.pathname);
    if (img) {
      const it = images.get(img[1]);
      if (!it || it.exp < Date.now()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': it.type || 'image/png', 'cache-control': 'public, max-age=3600' });
      return res.end(it.buf);
    }

    if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }

    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end();
  }
});

// ---------- Live drawing rooms ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') return socket.destroy();
  const user = verifyInitData(url.searchParams.get('initData'));
  const token = url.searchParams.get('token');
  if (!user || !getSession(token)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, user, token));
});

function broadcast(room, msg, except) {
  const s = JSON.stringify(msg);
  for (const c of room.clients) if (c.ws !== except && c.ws.readyState === 1) c.ws.send(s);
}

// ---- what a drawing operation may contain (everything from clients is validated) ----
const TOOLS = new Set(['pencil', 'pen', 'marker', 'brush', 'airbrush', 'chalk', 'highlighter', 'eraser']);
const FONTS = new Set(['sans', 'serif', 'mono', 'hand']);
const SHAPES = new Set(['line', 'rect', 'ellipse']);
const BLENDS = new Set(['source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten']);
const MAX_LAYERS = 8;
const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const colour = (c) => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#000000');
const newLayer = (id, name = 'Layer') => ({ id, name, visible: true, opacity: 1, blend: 'source-over' });

function cleanLayer(l, id) {
  return {
    id,
    name: typeof l?.name === 'string' ? l.name.slice(0, 20) : 'Layer',
    visible: l?.visible !== false,
    opacity: num(l?.opacity, 0, 1, 1),
    blend: BLENDS.has(l?.blend) ? l.blend : 'source-over',
  };
}

function cleanOp(o, layers) {
  if (!o || typeof o.id !== 'string' || o.id.length === 0 || o.id.length > 16) return null;
  const base = { id: o.id, k: o.k, l: layers.some((L) => L.id === o.l) ? o.l : layers[0].id };
  switch (o.k) {
    case 'stroke':
      if (!TOOLS.has(o.tool) || !Array.isArray(o.pts) || o.pts.length > MAX_PTS) return null;
      return {
        ...base, tool: o.tool, color: colour(o.color), size: num(o.size, 1, 200, 6), op: num(o.op, 0.02, 1, 1),
        sym: num(o.sym | 0, 0, 3, 0), pts: o.pts.map((n) => num(n, -300, 3300, 0)),
        ...(Array.isArray(o.pr) ? { pr: o.pr.slice(0, MAX_PTS / 2).map((n) => num(n, 0, 100, 50)) } : {}),
      };
    case 'fill':
      return { ...base, x: num(o.x, 0, 3000, 0), y: num(o.y, 0, 3000, 0), color: colour(o.color) };
    case 'shape':
      if (!SHAPES.has(o.shape)) return null;
      return {
        ...base, shape: o.shape, x1: num(o.x1, -300, 3300, 0), y1: num(o.y1, -300, 3300, 0), x2: num(o.x2, -300, 3300, 0), y2: num(o.y2, -300, 3300, 0),
        color: colour(o.color), size: num(o.size, 1, 200, 6), op: num(o.op, 0.02, 1, 1), f: !!o.f, sym: num(o.sym | 0, 0, 3, 0),
      };
    case 'text':
      if (typeof o.text !== 'string' || !o.text.trim()) return null;
      return { ...base, text: o.text.slice(0, 200), x: num(o.x, -300, 3300, 0), y: num(o.y, -300, 3300, 0), color: colour(o.color), size: num(o.size, 6, 400, 40), font: FONTS.has(o.font) ? o.font : 'sans', op: num(o.op, 0.02, 1, 1) };
    case 'move':
      return {
        ...base, x: num(o.x, 0, 3000, 0), y: num(o.y, 0, 3000, 0), w: num(o.w, 1, 3000, 1), h: num(o.h, 1, 3000, 1),
        tx: num(o.tx, -3000, 3000, 0), ty: num(o.ty, -3000, 3000, 0), s: num(o.s, 0.05, 20, 1), r: num(o.r, -50, 50, 0),
      };
    default: return null;
  }
}

function onConnect(ws, user, token) {
  let room = rooms.get(token);
  if (!room) {
    rooms.set(token, (room = {
      ops: [], layers: [newLayer('L1', 'Layer 1')], redo: new Map(), bg: '#ffffff', size: 'square',
      clients: new Set(), users: new Map(), version: 0, posted: -1,
    }));
  }
  room.users.set(user.id, user);
  const me = { ws, uid: user.id };
  room.clients.add(me);
  ws.send(JSON.stringify({ t: 'init', ops: room.ops, layers: room.layers, bg: room.bg, size: room.size, peers: room.clients.size }));
  broadcast(room, { t: 'peers', n: room.clients.size });

  const findOp = (id) => { for (let i = room.ops.length - 1; i >= 0; i--) if (room.ops[i].id === id) return room.ops[i]; return null; };

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.t) {
      case 'op': { // a stroke starts (points follow), or a fill / shape / text / move arrives whole
        if (room.ops.length >= MAX_OPS) return;
        const o = cleanOp(m.op, room.layers);
        if (!o) return;
        o.u = me.uid;
        room.ops.push(o); room.version++;
        room.redo.set(me.uid, []); // a new action ends the redo history
        broadcast(room, { t: 'op', op: o }, ws);
        break;
      }
      case 'pts': {
        const o = findOp(m.id);
        if (!o || o.k !== 'stroke' || o.u !== me.uid || !Array.isArray(m.pts) || o.pts.length + m.pts.length > MAX_PTS) return;
        const pts = m.pts.map((n) => num(n, -300, 3300, 0));
        o.pts.push(...pts);
        let pr;
        if (Array.isArray(m.pr) && o.pr) { pr = m.pr.slice(0, pts.length / 2).map((n) => num(n, 0, 100, 50)); o.pr.push(...pr); }
        room.version++;
        broadcast(room, { t: 'pts', id: m.id, pts, ...(pr ? { pr } : {}) }, ws);
        break;
      }
      case 'end': { const o = findOp(m.id); if (o && o.u === me.uid) broadcast(room, { t: 'end', id: m.id }, ws); break; }
      case 'undo': {
        for (let i = room.ops.length - 1; i >= 0; i--) {
          if (room.ops[i].u === me.uid) {
            const [o] = room.ops.splice(i, 1); room.version++;
            const stack = room.redo.get(me.uid) || [];
            stack.push({ op: o, index: i }); if (stack.length > 50) stack.shift();
            room.redo.set(me.uid, stack);
            broadcast(room, { t: 'remove', id: o.id });
            return;
          }
        }
        break;
      }
      case 'redo': {
        const stack = room.redo.get(me.uid) || [];
        const item = stack.pop();
        if (!item || !room.layers.some((L) => L.id === item.op.l)) return;
        const index = Math.min(item.index, room.ops.length);
        room.ops.splice(index, 0, item.op); room.version++;
        broadcast(room, { t: 'insert', op: item.op, index });
        break;
      }
      case 'clear': room.version++; room.ops = []; room.redo = new Map(); broadcast(room, { t: 'clear' }); break;
      case 'bg': if (m.bg === 'transparent' || /^#[0-9a-fA-F]{6}$/.test(m.bg)) { room.bg = m.bg; room.version++; broadcast(room, { t: 'bg', bg: m.bg }); } break;
      case 'size': if (SIZES.has(m.size)) { room.size = m.size; room.version++; broadcast(room, { t: 'size', size: m.size }); } break;
      case 'layer': {
        const L = room.layers;
        if (m.act === 'add') {
          if (L.length >= MAX_LAYERS || typeof m.layer?.id !== 'string' || m.layer.id.length > 12 || L.some((x) => x.id === m.layer.id)) return;
          const layer = cleanLayer(m.layer, m.layer.id);
          const at = Math.min(Math.max(num(m.at, 0, L.length, L.length) | 0, 0), L.length);
          L.splice(at, 0, layer); room.version++;
          broadcast(room, { t: 'layer', act: 'add', layer, at }, ws);
        } else if (m.act === 'upd') {
          const layer = L.find((x) => x.id === m.id);
          if (!layer) return;
          Object.assign(layer, cleanLayer({ ...layer, ...m.props }, layer.id)); room.version++;
          broadcast(room, { t: 'layer', act: 'upd', id: layer.id, props: layer }, ws);
        } else if (m.act === 'order') {
          if (!Array.isArray(m.ids) || m.ids.length !== L.length || !L.every((x) => m.ids.includes(x.id))) return;
          room.layers = m.ids.map((id) => L.find((x) => x.id === id)); room.version++;
          broadcast(room, { t: 'layer', act: 'order', ids: m.ids }, ws);
        } else if (m.act === 'del') {
          if (L.length < 2 || !L.some((x) => x.id === m.id)) return;
          room.layers = L.filter((x) => x.id !== m.id);
          room.ops = room.ops.filter((o) => o.l !== m.id);
          room.redo = new Map(); room.version++;
          broadcast(room, { t: 'sync', ops: room.ops, layers: room.layers }); // everyone, sender included
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    room.clients.delete(me);
    broadcast(room, { t: 'peers', n: room.clients.size });
  });
}

// housekeeping
setInterval(() => {
  const now = Date.now();
  for (const [id, it] of images) if (it.exp < now) images.delete(id);
}, 60_000).unref();

server.listen(PORT, async () => {
  console.log(`listening on :${PORT}`);
  if (!bot) return;
  await bot.init();
  console.log(`bot @${bot.botInfo.username}`);
  if (!MINIAPP_SHORT) console.warn('MINIAPP_SHORT is not set - create the Mini App in @BotFather (/newapp) and set it');
  if (PUBLIC_URL) {
    await bot.api.setWebhook(`${PUBLIC_URL}/tg/${webhookSecret}`);
    await bot.api.setMyCommands([{ command: 'draw', description: 'Start a drawing' }]);
    try { // the "Draw" button next to the message box in every DM opens the canvas directly
      await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: '🎨 Draw', web_app: { url: `${WEBAPP_URL}?p=s_me` } } });
    } catch (e) { console.warn('menu button not set:', e.description || e.message); }
    console.log('webhook set');
  } else console.warn('PUBLIC_URL is not set - webhook not registered');
});
