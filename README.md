# ScribbleJam

Telegram drawing bot. `/draw` posts two buttons: **Draw alone** and **Draw together** (live shared canvas).
When finished: send picture to chat, post to story, or turn into a sticker (white or transparent background).

## Setup
1. @BotFather → `/newbot` → display name `ScribbleJam`, username e.g. `Scribblejam_bot` → copy the token.
2. Deploy to Render (new Web Service, this folder). Env vars: `BOT_TOKEN`, `PUBLIC_URL` (your https onrender.com URL, no trailing slash), `MINIAPP_SHORT`.
3. @BotFather → `/newapp` → pick your bot → Web App URL = `PUBLIC_URL`, short name = `MINIAPP_SHORT` (e.g. `draw`). The two must match exactly: the buttons open `t.me/<yourbot>/<short name>`.
4. @BotFather → `/setjoingroups` → enable. Add the bot to a group, send `/draw`.

## Local test
`DEV=1 node server.js`, then open `http://localhost:3000/?p=t_room` in two tabs (together) or `?p=s_x` (alone).
For real Telegram testing locally, run a tunnel (`cloudflared tunnel --url http://localhost:3000`) and use its URL as `PUBLIC_URL`.

## Notes
- Sessions/rooms are in memory: a Render restart or sleep clears them (send `/draw` again).
- Stickers: each user gets one pack `d<userid>_by_<bot>`; Telegram caps packs at 120 stickers.
- Finished doodles are captioned `Doodle by @username` (or the person's name if they have no username). In a shared room, everyone who drew is listed.
- Each tool (pencil, pen, brush, eraser) has its own adjustable size; the bucket has none.

## Skipping Render's "service waking up" screen
The Mini App page lives in `docs/`. If it is served by the Render service itself, Telegram users see Render's own
wake-up screen whenever the free service has been idle. To show the ScribbleJam loading screen instead, host `docs/`
on GitHub Pages (always on, free) and let it wake the server:
1. In `docs/config.js` set `window.SJ_API = 'https://<your-service>.onrender.com'`.
2. Repo **Settings → Pages**: source `main`, folder `/docs`. You get `https://<user>.github.io/ScribbleJam/`.
3. @BotFather → `/myapps` → ScribbleJam → **Edit Web App URL** → the Pages URL.
4. Keep `PUBLIC_URL` on Render as the Render address (the webhook and story images still use it).

Draw-alone opens instantly (the server wakes in the background); draw-together shows the splash until it is awake.
