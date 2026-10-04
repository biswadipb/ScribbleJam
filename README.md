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
