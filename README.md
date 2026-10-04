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
- Pressing **Finish** posts the picture to the chat it was started from, captioned `Drawn by @username` (people without a username are tagged by name, and without a name by user id). In a shared room everyone who drew is listed, and each version of the drawing is posted once.
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
- Canvas: starts as a white standard square (1024×1024). 🖼️ Canvas lets you pick Square, Portrait, Landscape, Wide or Story, and any background colour or none (transparent). In a shared room, size and colour change for everyone.
- After Finish: send to another chat (Telegram share dialog, needs Telegram 8.0+), share to other apps, save the image, post to story, or make a sticker. Every picture carries a deep purple "Drawn by <names>" footer with the ScribbleJam logo (never on stickers).

## Drawing tools
- **Brushes:** pencil, ink pen, marker, soft brush, airbrush, chalk, highlighter and an eraser, each with its own size and opacity. Pen pressure is used when the device reports it.
- **Also:** paint bucket, colour picker (eyedropper), line / rectangle / ellipse (outline or filled), text, and a rectangle **Select** tool to move, rotate and scale part of a layer.
- **Layers** (up to 8): add, hide, reorder, rename, delete, per-layer opacity and blend mode (normal, multiply, screen, overlay, darken, lighten). They sync live in a shared room.
- **Mirror drawing** (left/right, up/down, both), stroke **smoothing**, undo / **redo**, and **pinch to zoom / pan** (a *Fit* button resets the view).
- **Colours:** 12 quick slots plus a full colour picker (colour square + hue) that remembers your recent colours.
- Everything drawn is a list of operations (`stroke`, `fill`, `shape`, `text`, `move`), each tagged with its layer; the server validates every operation before relaying it.
- Layer blend modes are applied on top of the canvas colour at export time only approximately: the canvas colour sits behind all layers, so e.g. *screen* over a white canvas is not identical to a paint app that treats the background as a layer.

## Private chats (DMs)
Writing to the bot in a DM (or pressing its **🎨 Draw** menu button) goes straight to a one-person canvas: no alone/together choice. The finished picture is sent back to that DM. This uses a `web_app` button, so it needs no BotFather setup. The page is served from `WEBAPP_URL` (defaults to the GitHub Pages site; set the env var on Render to use another host).
