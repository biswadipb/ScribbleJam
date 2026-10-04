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

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_OPS = 3000;
const MAX_PTS = 20000; // numbers per stroke

// token -> { chatId, title }   (one per /draw command; lost on restart)
const sessions = new Map();
// token -> { ops, bg, clients:Set }
const rooms = new Map();
// id -> { buf, exp }  short-lived PNGs for story sharing
const images = new Map();

const rand = (n = 6) => crypto.randomBytes(n).toString('hex');

// ---------- Telegram initData verification ----------
function verifyInitData(initData) {
  if (DEV && initData === 'dev') return { id: 1, first_name: 'Dev' };
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

if (bot) {
  bot.command(['draw', 'start'], async (ctx) => {
    const token = rand(6);
    sessions.set(token, { chatId: ctx.chat.id, title: ctx.chat.title });
    const link = (m) => `https://t.me/${bot.botInfo.username}/${MINIAPP_SHORT}?startapp=${m}_${token}`;
    await ctx.reply('🎨 How do you want to draw?', {
      reply_markup: {
        inline_keyboard: [[
          { text: '✏️ Draw alone', url: link('s') },
          { text: '👥 Draw together', url: link('t') },
        ]],
      },
    });
  });
}

// ---------- Export (print / story / sticker) ----------
async function handleExport(body) {
  const user = verifyInitData(body.initData);
  if (!user) return [401, { error: 'bad initData' }];
  const session = sessions.get(body.token);
  if (!session) return [410, { error: 'This drawing session expired. Send /draw again.' }];
  const m = /^data:image\/png;base64,(.+)$/.exec(body.png || '');
  if (!m) return [400, { error: 'png required' }];
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return [400, { error: 'not a png' }];

  const name = user.first_name || 'Someone';

  if (body.action === 'print') {
    const file = new InputFile(buf, 'drawing.png');
    if (body.bg === 'transparent') {
      await bot.api.sendDocument(session.chatId, file, { caption: `🎨 by ${name} (transparent PNG)` });
    } else {
      await bot.api.sendPhoto(session.chatId, file, { caption: `🎨 by ${name}` });
    }
    return [200, { ok: true }];
  }

  if (body.action === 'story') {
    const id = rand(8);
    images.set(id, { buf, exp: Date.now() + 10 * 60_000 });
    return [200, { url: `${PUBLIC_URL}/img/${id}.png` }];
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
  try {
    if (req.method === 'POST' && tgHandler && url.pathname === `/tg/${webhookSecret}`) return tgHandler(req, res);

    if (req.method === 'POST' && url.pathname === '/api/export') {
      let status, out;
      try { [status, out] = await handleExport(await readJson(req)); }
      catch (e) { console.error(e); [status, out] = [500, { error: e.description || e.message || 'failed' }]; }
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(out));
    }

    const img = /^\/img\/([a-f0-9]+)\.png$/.exec(url.pathname);
    if (img) {
      const it = images.get(img[1]);
      if (!it || it.exp < Date.now()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'image/png' });
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
  if (DEV && token && !sessions.has(token)) sessions.set(token, { chatId: 0 });
  if (!user || !sessions.has(token)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, user, token));
});

function broadcast(room, msg, except) {
  const s = JSON.stringify(msg);
  for (const c of room.clients) if (c.ws !== except && c.ws.readyState === 1) c.ws.send(s);
}

function onConnect(ws, user, token) {
  let room = rooms.get(token);
  if (!room) rooms.set(token, (room = { ops: [], bg: 'white', clients: new Set() }));
  const me = { ws, uid: user.id };
  room.clients.add(me);
  ws.send(JSON.stringify({ t: 'init', ops: room.ops, bg: room.bg, peers: room.clients.size }));
  broadcast(room, { t: 'peers', n: room.clients.size });

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.t) {
      case 'op': { // stroke start or fill
        const o = m.op;
        if (!o || typeof o.id !== 'string' || room.ops.length >= MAX_OPS) return;
        if (o.k === 'stroke') { if (!Array.isArray(o.pts) || o.pts.length > MAX_PTS) return; }
        else if (o.k !== 'fill') return;
        o.u = me.uid;
        room.ops.push(o);
        broadcast(room, { t: 'op', op: o }, ws);
        break;
      }
      case 'pts': {
        for (let i = room.ops.length - 1; i >= 0; i--) {
          const o = room.ops[i];
          if (o.id === m.id) {
            if (o.u !== me.uid || !Array.isArray(m.pts) || o.pts.length + m.pts.length > MAX_PTS) return;
            o.pts.push(...m.pts);
            broadcast(room, { t: 'pts', id: m.id, pts: m.pts }, ws);
            return;
          }
        }
        break;
      }
      case 'undo': {
        for (let i = room.ops.length - 1; i >= 0; i--) {
          if (room.ops[i].u === me.uid) {
            const [o] = room.ops.splice(i, 1);
            broadcast(room, { t: 'remove', id: o.id });
            return;
          }
        }
        break;
      }
      case 'clear': room.ops = []; broadcast(room, { t: 'clear' }); break;
      case 'bg': if (m.bg === 'white' || m.bg === 'transparent') { room.bg = m.bg; broadcast(room, { t: 'bg', bg: m.bg }); } break;
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
    console.log('webhook set');
  } else console.warn('PUBLIC_URL is not set - webhook not registered');
});
