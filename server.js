import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Bot, InputFile, webhookCallback } from 'grammy';
import { WebSocketServer } from 'ws';

const { BOT_TOKEN, PORT = 3000, DEV } = process.env;
// short name of the Mini App in @BotFather (/newapp); group buttons open t.me/<bot>/<this name>
const MINIAPP_SHORT = (process.env.MINIAPP_SHORT || 'draw').trim();
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, ''); // no trailing slash, whatever was typed
if (!BOT_TOKEN && !DEV) {
  console.error('BOT_TOKEN is required (or set DEV=1 to run without Telegram)');
  process.exit(1);
}

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'docs');
const MAX_OPS = 3000;                                   // operations (strokes, fills, shapes...) one drawing can hold
const MAX_PEOPLE = Number(process.env.MAX_PEOPLE) || 12; // people drawing in one shared room at once
const SIZES = new Set(['square', 'portrait', 'landscape', 'wide', 'story']);
const MAX_PTS = 20000; // numbers per stroke

// Session tokens are signed and self-contained, so they keep working after Render restarts the service.
//   alone / DM:        <chat>x<nonce>x<sig>
//   drawing together:  <chat>x<nonce><o|c><hostId>x<sig>   o = open (anyone may join), c = closed (needs approval)
// The open/closed choice and the host are inside the signed part, so a link can't be edited to change them.
// Only the live canvas (rooms) is held in memory.
const sign = (s) => crypto.createHmac('sha256', BOT_TOKEN || 'dev').update(s).digest('base64url').slice(0, 10);
function makeToken(chatId, policy = '', hostId = 0) {
  const body = `${String(chatId).replace('-', 'n')}x${rand(4)}${policy ? policy + hostId : ''}`;
  return `${body}x${sign(body)}`;
}
function getSession(token) {
  const m = /^((n?\d+)x([0-9a-f]{8})(?:([oc])(\d+))?)x([A-Za-z0-9_-]{10})$/.exec(token || '');
  if (m && sign(m[1]) === m[6]) return { chatId: Number(m[2].replace('n', '-')), policy: m[4] === 'c' ? 'c' : 'o', hostId: m[5] ? Number(m[5]) : 0 };
  if (DEV && token) { // local testing: any token works; "closed<hostId>" makes a closed room
    const d = /^closed(\d+)$/.exec(token);
    return { chatId: 0, policy: d ? 'c' : 'o', hostId: d ? Number(d[1]) : 0 };
  }
  return null;
}
// A pass lets someone who was let into a closed room come back (after a disconnect or a server restart) without asking again.
const passFor = (token, uid) => crypto.createHmac('sha256', 'pass:' + (BOT_TOKEN || 'dev')).update(`${token}:${uid}`).digest('base64url').slice(0, 22);
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
// What /status reports: only yes/no facts and counters, nothing secret.
const status = { botStarted: false, webhookSet: false, menuButtonSet: false, publicUrlSet: !!PUBLIC_URL, miniAppShortSet: !!process.env.MINIAPP_SHORT, miniAppShort: MINIAPP_SHORT, updatesReceived: 0, lastUpdateAt: 0, lastError: null };
// In DEV (no token) sends are just logged, so the Finish flow can be tested without Telegram.
const tgApi = bot ? bot.api : DEV ? {
  sendPhoto: async (chat, _f, o) => console.log('DEV sendPhoto', JSON.stringify(o.caption)),
  sendDocument: async (chat, _f, o) => console.log('DEV sendDocument', JSON.stringify(o.caption)),
} : null;

// Where the Mini App page lives (set WEBAPP_URL to a host that never sleeps; falls back to PUBLIC_URL). Private chats open it with a web_app
// button, which has no sleepy-server wait and no choice to make: a DM is always a one-person canvas.
const WEBAPP_URL = (process.env.WEBAPP_URL || PUBLIC_URL || '').replace(/\/?$/, '/');

async function sendDrawPrompt(ctx) {
  if (ctx.chat.type === 'private') {
    const text = '🎨 Tap to start drawing. When you finish, the picture comes back to this chat.';
    // the link button works in every chat and opens the same one-person canvas ("me" = your own DM)
    const linkButton = { text: '🎨 Start drawing', url: `https://t.me/${bot.botInfo.username}/${MINIAPP_SHORT}?startapp=s_me` };
    const webAppButton = /^https:\/\//.test(WEBAPP_URL) ? { text: '🎨 Start drawing', web_app: { url: `${WEBAPP_URL}?p=s_me` } } : null;
    try {
      await ctx.reply(text, { reply_markup: { inline_keyboard: [[webAppButton || linkButton]] } });
    } catch (e) { // Telegram refused the button: say so in the log and still answer with the plain link
      console.error('DM prompt failed with the web_app button:', e.description || e.message, '| url:', WEBAPP_URL);
      await ctx.reply(text, { reply_markup: { inline_keyboard: [[linkButton]] } });
    }
    return;
  }
  // groups
  await ctx.reply(...groupPrompt(ctx.chat.id));
}

// ---- group flow: Draw alone / Draw together -> Open or Closed -> "Join active session" ----
const activeSessions = new Map();          // chat id -> the drawing-together session currently on offer there
const SESSION_KEEP_MS = 12 * 3600_000;
const sessionLink = (m, token) => `https://t.me/${bot.botInfo.username}/${MINIAPP_SHORT}?startapp=${m}_${token}`;
const policyIcon = (p) => (p === 'c' ? '🔒' : '🔓');
const personName = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Someone';

function groupPrompt(chatId) {
  const rows = [];
  const act = activeSessions.get(chatId);
  if (act && Date.now() - act.at < SESSION_KEEP_MS) {
    rows.push([{ text: `🎨 Join active session ${policyIcon(act.policy)}`, url: sessionLink('t', act.token) }]);
  } else activeSessions.delete(chatId);
  rows.push([
    { text: '✏️ Draw alone', url: sessionLink('s', makeToken(chatId)) },
    { text: '👥 Draw together', callback_data: 'sj:together' },
  ]);
  const text = act && rows.length > 1
    ? `🎨 A drawing is open (started by ${act.host}, ${act.policy === 'c' ? 'closed 🔒' : 'open 🔓'}). Join it, or start something new:`
    : '🎨 How do you want to draw?';
  return [text, { reply_markup: { inline_keyboard: rows } }];
}

if (bot) {
  bot.use((ctx, next) => { status.updatesReceived++; status.lastUpdateAt = Date.now(); return next(); });
  bot.catch((err) => {
    status.lastError = err.error?.description || err.error?.message || err.message;
    console.error('bot error while handling an update:', status.lastError);
  });
  bot.command(['draw', 'start'], sendDrawPrompt);

  // "Draw together" asks who may join
  bot.callbackQuery('sj:together', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageText('👥 Who can join this drawing?\n\n🔓 Open group: anyone in the chat can join.\n🔒 Closed group: people ask to join, and someone already drawing lets them in.', {
      reply_markup: { inline_keyboard: [
        [{ text: '🔓 Open group', callback_data: 'sj:open' }, { text: '🔒 Closed group', callback_data: 'sj:closed' }],
        [{ text: '↩️ Back', callback_data: 'sj:back' }],
      ] },
    }).catch((e) => console.warn('could not edit the prompt:', e.description || e.message));
  });
  bot.callbackQuery('sj:back', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const [text, extra] = groupPrompt(ctx.chat.id);
    await ctx.editMessageText(text, extra).catch(() => {});
  });
  // the person who chooses becomes the host of the session
  bot.callbackQuery(['sj:open', 'sj:closed'], async (ctx) => {
    const policy = ctx.callbackQuery.data === 'sj:closed' ? 'c' : 'o';
    const host = personName(ctx.from);
    const token = makeToken(ctx.chat.id, policy, ctx.from.id);
    activeSessions.set(ctx.chat.id, { token, policy, host, at: Date.now() });
    await ctx.answerCallbackQuery({ text: policy === 'c' ? 'Closed session started - tap Join active session' : 'Open session started - tap Join active session' }).catch(() => {});
    await ctx.editMessageText(
      `👥 ${host} started a drawing together\n${policy === 'c' ? '🔒 Closed: you ask to join and someone drawing lets you in.' : '🔓 Open: anyone here can jump in.'}`,
      { reply_markup: { inline_keyboard: [[{ text: '🎨 Join active session', url: sessionLink('t', token) }]] } },
    ).catch((e) => console.warn('could not post the session:', e.description || e.message));
  });
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

// ---- who gets credit ----
// A rough measure of how much of the picture one operation is: the area of ink it laid down.
const WIDTH_OF = { pencil: 0.5, marker: 1.4, brush: 1.8, highlighter: 2.2 }; // everything else: the size itself
const FILL_WEIGHT = 30000;       // a bucket fill covers a lot, but how much is unknown here: count it as a decent chunk
// "Insignificant" means 10 against 90: someone who drew less than 10 for every 90 the biggest contributor drew is not named.
const CREDIT_P = Number(process.env.CREDIT_MIN_PERCENT) || 10;
const CREDIT_RATIO = CREDIT_P / (100 - CREDIT_P);   // 10/90 = 0.111 of the biggest contributor's amount
const mirrorCount = (sym) => (sym === 3 ? 4 : sym ? 2 : 1);
function inkOf(o) {
  if (o.k === 'stroke') {
    if (o.tool === 'eraser') return 0; // erasing is not drawing
    const w = o.size * (WIDTH_OF[o.tool] ?? 1);
    let len = 0;
    for (let i = 2; i < o.pts.length; i += 2) len += Math.hypot(o.pts[i] - o.pts[i - 2], o.pts[i + 1] - o.pts[i - 1]);
    return (len + w) * w * mirrorCount(o.sym);
  }
  if (o.k === 'shape') {
    const dx = Math.abs(o.x2 - o.x1), dy = Math.abs(o.y2 - o.y1);
    const outline = (o.shape === 'line' ? Math.hypot(dx, dy) : 2 * (dx + dy)) * o.size;
    return (outline + (o.f && o.shape !== 'line' ? dx * dy : 0)) * mirrorCount(o.sym);
  }
  if (o.k === 'fill') return FILL_WEIGHT;
  return 0; // moves don't add anything
}

// Who the picture is credited to ("Drawn by ..." on the image and in the caption).
// Alone: the person who finished it. In a shared room: everyone who drew at least 10 for every 90 that the
// biggest contributor drew, biggest first. The test is relative to the leader, so it means the same
// thing whether 2 or 12 people are drawing: with 2 people it works out to "at least 10% of the picture",
// with 12 people a handful of small touches next to a big drawing still isn't enough, but 12 people who
// each drew a fair part are all named. Nobody who drew nothing is ever named.
function artists(token, finisher, mode) {
  const room = mode === 'together' ? rooms.get(token) : null;
  if (!room) return [finisher];
  const ink = new Map();
  for (const o of room.ops) {
    const w = inkOf(o);
    if (w > 0) ink.set(o.u, (ink.get(o.u) || 0) + w);
  }
  if (!ink.size) { // only moves / erasing so far: whoever touched it
    const who = [...new Set(room.ops.map((o) => o.u))].map((id) => room.users.get(id)).filter(Boolean);
    return who.length ? who : [finisher];
  }
  const ranked = [...ink.entries()].sort((x, y) => y[1] - x[1]);
  const lead = ranked[0][1];
  const list = ranked.filter(([, w]) => w >= lead * CREDIT_RATIO).map(([id]) => room.users.get(id)).filter(Boolean);
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

// ---------- never let one bad request kill the server ----------
// (Render reported "Exited with status 1": an odd web address, a malformed websocket message or an
// oversized one used to throw outside any handler and end the process, wiping every drawing in memory.)
process.on('uncaughtException', (e) => console.error('uncaught exception (kept running):', e?.message || e));
process.on('unhandledRejection', (e) => console.error('unhandled rejection (kept running):', e?.message || e));

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
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end('bad request'); }
  // The Mini App page may be served from a static host (GitHub Pages) that calls this server.
  // Requests are authenticated by Telegram initData, not cookies, so open CORS is fine.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (req.method === 'POST' && tgHandler && url.pathname === `/tg/${webhookSecret}`) return await tgHandler(req, res); // await: a failure must land in the catch below

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
    if (url.pathname === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      const { lastUpdateAt, ...rest } = status;
      return res.end(JSON.stringify({ ...rest, secondsSinceLastUpdate: lastUpdateAt ? Math.round((Date.now() - lastUpdateAt) / 1000) : null }));
    }

    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error('request failed:', e?.message || e);
    if (!res.headersSent) { try { res.writeHead(500); } catch {} }
    try { res.end(); } catch {}
  }
});
server.on('clientError', (err, socket) => { try { socket.destroy(); } catch {} });

// ---------- Live drawing rooms ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 8_000_000 }); // room for a restored drawing
wss.on('error', (e) => console.error('websocket server error:', e?.message || e));

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { return socket.destroy(); }
  socket.on('error', () => {});
  if (url.pathname !== '/ws') return socket.destroy();
  const user = verifyInitData(url.searchParams.get('initData'));
  const token = url.searchParams.get('token');
  if (!user || !getSession(token)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, user, token, url.searchParams.get('pass')));
});

function broadcast(room, msg, except) {
  const s = JSON.stringify(msg);
  for (const c of room.clients) if (c.ws !== except && c.ws.readyState === 1) c.ws.send(s);
}

// ---- what a drawing operation may contain (everything from clients is validated) ----
const TOOLS = new Set(['pencil', 'pen', 'marker', 'brush', 'airbrush', 'chalk', 'highlighter', 'eraser']);
const SHAPES = new Set(['line', 'rect', 'ellipse']);
const BLENDS = new Set(['source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten']);
const MAX_LAYERS = 8;
const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const colour = (c) => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#000000');
const newLayer = (id, name = 'Layer') => ({ id, name, visible: true, opacity: 1, blend: 'source-over' });

// A user record the server signs when it hands it out, so a client can later bring it back (restoring a
// drawing after the server slept) without being able to invent names for the "Drawn by" credits.
const userSecret = 'users:' + (BOT_TOKEN || 'dev');
function signUser(u) {
  const c = { id: u.id, first_name: u.first_name || '', last_name: u.last_name || '', username: u.username || '' };
  return { u: c, sig: crypto.createHmac('sha256', userSecret).update(JSON.stringify(c)).digest('base64url').slice(0, 16) };
}
function verifyUser(x) {
  if (!x || typeof x.sig !== 'string' || !x.u || !Number.isFinite(x.u.id)) return null;
  const e = signUser(x.u);
  return e.sig === x.sig ? x.u : null;
}

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
    default: return null;
  }
}

const publicUser = (u) => ({ id: u.id, name: fullName(u), username: u.username || '' });
const MAX_PENDING = 10;

function onConnect(ws, user, token, pass) {
  const session = getSession(token);
  let room = rooms.get(token);
  if (!room) {
    rooms.set(token, (room = {
      ops: [], layers: [newLayer('L1', 'Layer 1')], redo: new Map(), bg: '#ffffff', size: 'square',
      clients: new Set(), users: new Map(), version: 0, posted: -1, touched: false, lastSeen: Date.now(),
      policy: session.policy, hostId: session.hostId, approved: new Set(), pending: new Map(),
    }));
  }
  ws.on('error', (e) => console.warn('websocket client error:', e?.message || e)); // e.g. a frame that is too big
  // Closed room: the host walks in; anyone who was let in before comes back with their pass; everyone else asks.
  const mayEnter = room.policy !== 'c' || user.id === room.hostId || room.approved.has(user.id) || (pass && pass === passFor(token, user.id));
  if (mayEnter) { if (room.policy === 'c') room.approved.add(user.id); return joinRoom(ws, user, token, room); }
  return askToEnter(ws, user, token, room);
}

// Someone is at the door of a closed room: tell the people inside and wait for a yes or no.
function askToEnter(ws, user, token, room) {
  if (room.pending.size >= MAX_PENDING && !room.pending.has(user.id)) { ws.send(JSON.stringify({ t: 'busy' })); return ws.close(); }
  const earlier = room.pending.get(user.id);
  if (earlier) { try { earlier.ws.close(); } catch {} }
  room.pending.set(user.id, { ws, user });
  ws.send(JSON.stringify({ t: 'waiting', someoneInside: room.clients.size > 0 }));
  broadcast(room, { t: 'joinreq', user: publicUser(user) });
  ws.on('message', () => {}); // nothing is accepted from someone who is not in yet
  ws.on('close', () => {
    if (room.pending.get(user.id)?.ws === ws) { room.pending.delete(user.id); broadcast(room, { t: 'joinreq-cancel', id: user.id }); }
  });
}

function joinRoom(ws, user, token, room) {
  if (room.clients.size >= MAX_PEOPLE) { // keep the free server healthy: a room holds MAX_PEOPLE people
    ws.send(JSON.stringify({ t: 'roomfull', max: MAX_PEOPLE }));
    return ws.close();
  }
  room.users.set(user.id, user);
  room.lastSeen = Date.now();
  const me = { ws, uid: user.id };
  room.clients.add(me);
  ws.send(JSON.stringify({
    t: 'init', ops: room.ops, layers: room.layers, bg: room.bg, size: room.size, peers: room.clients.size,
    fresh: !room.touched, users: [...room.users.values()].map(signUser),
    policy: room.policy, pending: [...room.pending.values()].map((p) => publicUser(p.user)),
    invite: bot?.botInfo ? `https://t.me/${bot.botInfo.username}/${MINIAPP_SHORT}?startapp=t_${token}` : null,
  }));
  broadcast(room, { t: 'peers', n: room.clients.size });
  broadcast(room, { t: 'user', user: signUser(user) }, ws);

  const findOp = (id) => { for (let i = room.ops.length - 1; i >= 0; i--) if (room.ops[i].id === id) return room.ops[i]; return null; };

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    try { handleMessage(m); } catch (e) { console.error('could not handle a message:', e?.message || e); }
  });

  function handleMessage(m) {
    switch (m.t) {
      case 'op': { // a stroke starts (points follow), or a fill / shape / text / move arrives whole
        if (room.ops.length >= MAX_OPS) { ws.send(JSON.stringify({ t: 'full', id: m.op?.id })); return; }
        const o = cleanOp(m.op, room.layers);
        if (!o) return;
        o.u = me.uid; room.touched = true;
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
      case 'restore': { // the server forgot this drawing (it slept / restarted): bring it back from a participant's saved copy
        if (room.touched || room.ops.length || !Array.isArray(m.layers) || !Array.isArray(m.ops)) return;
        const layers = [];
        for (const l of m.layers.slice(0, MAX_LAYERS)) if (typeof l?.id === 'string' && l.id.length <= 12 && !layers.some((x) => x.id === l.id)) layers.push(cleanLayer(l, l.id));
        if (!layers.length) return;
        const trusted = new Set([me.uid]);
        for (const x of Array.isArray(m.users) ? m.users.slice(0, 100) : []) { const u = verifyUser(x); if (u) { trusted.add(u.id); if (!room.users.has(u.id)) room.users.set(u.id, { id: u.id, first_name: u.first_name || undefined, last_name: u.last_name || undefined, username: u.username || undefined }); } }
        const ops = [];
        for (const raw of m.ops.slice(0, MAX_OPS)) {
          const o = cleanOp(raw, layers);
          if (!o) continue;
          o.u = trusted.has(raw.u) ? raw.u : me.uid;
          ops.push(o);
        }
        room.layers = layers; room.ops = ops; room.touched = true; room.version++;
        if (m.bg === 'transparent' || /^#[0-9a-fA-F]{6}$/.test(m.bg)) room.bg = m.bg;
        if (SIZES.has(m.size)) room.size = m.size;
        broadcast(room, { t: 'sync', ops: room.ops, layers: room.layers, bg: room.bg, size: room.size });
        break;
      }
      case 'clear': room.touched = true; room.version++; room.ops = []; room.redo = new Map(); broadcast(room, { t: 'clear' }); break;
      case 'bg': if (m.bg === 'transparent' || /^#[0-9a-fA-F]{6}$/.test(m.bg)) { room.bg = m.bg; room.touched = true; room.version++; broadcast(room, { t: 'bg', bg: m.bg }); } break;
      case 'size': if (SIZES.has(m.size)) { room.size = m.size; room.touched = true; room.version++; broadcast(room, { t: 'size', size: m.size }); } break;
      case 'admit': { // a member lets a waiting person in (ok: true) or turns them away
        const p = room.pending.get(m.id);
        if (!p) return;
        room.pending.delete(m.id);
        broadcast(room, { t: 'joinreq-cancel', id: m.id }); // settled: remove the question from everyone's screen
        p.ws.removeAllListeners('message'); p.ws.removeAllListeners('close');
        if (m.ok === true) {
          room.approved.add(m.id);
          p.ws.send(JSON.stringify({ t: 'admitted', pass: passFor(token, m.id) }));
          joinRoom(p.ws, p.user, token, room);
        } else { p.ws.send(JSON.stringify({ t: 'declined' })); p.ws.close(); }
        break;
      }
      case 'layer': {
        const L = room.layers; room.touched = true;
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
  }

  ws.on('close', () => {
    room.lastSeen = Date.now();
    room.clients.delete(me);
    broadcast(room, { t: 'peers', n: room.clients.size });
  });
}

// housekeeping
setInterval(() => {
  const now = Date.now();
  for (const [id, it] of images) if (it.exp < now) images.delete(id);
  // forget rooms nobody has been in for a day (clients keep their own saved copy and can bring it back)
  for (const [tok, room] of rooms) if (room.clients.size === 0 && now - room.lastSeen > 24 * 3600_000) rooms.delete(tok);
}, 60_000).unref();

server.listen(PORT, async () => {
  console.log(`listening on :${PORT}`);
  if (!bot) return;
  try {
    await bot.init();
    status.botStarted = true;
    console.log(`bot @${bot.botInfo.username}`);
    if (!process.env.MINIAPP_SHORT) console.warn(`MINIAPP_SHORT is not set - using "${MINIAPP_SHORT}". Set it to the short name from @BotFather (/myapps) or the group buttons will say "Bot application not found"`);
    if (!PUBLIC_URL) { console.warn('PUBLIC_URL is not set - webhook NOT registered, so Telegram will never reach this bot'); return; }
    await bot.api.setWebhook(`${PUBLIC_URL}/tg/${webhookSecret}`);
    status.webhookSet = true;
    await bot.api.setMyCommands([{ command: 'draw', description: 'Start a drawing' }]);
    try { // the "Draw" button next to the message box in every DM opens the canvas directly
      await bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: '🎨 Draw', web_app: { url: `${WEBAPP_URL}?p=s_me` } } });
      status.menuButtonSet = true;
    } catch (e) { console.warn('menu button not set:', e.description || e.message); }
    console.log('webhook set');
  } catch (e) {
    status.lastError = e.description || e.message;
    console.error('startup problem:', status.lastError);
  }
});
