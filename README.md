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
The Mini App page lives in `docs/`. If it is served by the Render web service itself, people see Render's own
wake-up screen whenever the free service has been idle. To show the ScribbleJam loading screen instead, serve `docs/`
from a host that never sleeps and let it wake the server. A **Render Static Site** is free, always on, and gives a
neutral address (`https://<name>.onrender.com`) that does not contain anyone's personal username:
1. In `docs/config.js` set `window.SJ_API = 'https://<your-web-service>.onrender.com'`.
2. Render → **New → Static Site** → pick this repo, *Publish directory* `docs`, leave the build command empty.
3. On the Render **web service** set the env var `WEBAPP_URL` to the static site's address (DMs open the canvas from it).
4. @BotFather → `/myapps` → ScribbleJam → **Edit Web App URL** → the same address.
5. Keep `PUBLIC_URL` on the web service as its own address (webhook and story images use it).

Draw-alone opens instantly (the server wakes in the background); draw-together shows the splash until it is awake.
The app uses its own dialogs instead of the browser's `confirm()` / `prompt()` boxes, because those print the page's web address.

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

## Saving your progress
- **Alone:** the drawing is saved on your phone a moment after every change and comes back when you reopen the same canvas (7 days after the last change, or until you clear it). The DM canvas is one persistent canvas per person.
- **Shared:** the server keeps the drawing while it is awake. If it forgot it (free Render sleeps when idle), the first person to come back sends their saved copy and the room is rebuilt for everyone. User records are signed by the server, so a restored drawing cannot be used to invent names in the credits.
- Rooms that nobody has entered for 24 hours are dropped from server memory.

## Limits
- A shared room holds **12 people** at once (`MAX_PEOPLE` env var) and **3000 operations** (strokes, fills, shapes, text, moves). People are told when a drawing is full.

## Who is named in "Drawn by"
In a shared drawing a person is named only if they account for at least **10%** of what is on the canvas (`CREDIT_MIN_PERCENT`), biggest first. The 10% bar stays the same however many people join.
The share is measured as area of ink: strokes by length x width, shapes by outline (plus area when filled), text by size, a bucket fill counts as a fixed chunk; erasing and moving count for nothing. Undoing your strokes lowers your share. If nobody reaches 10% (e.g. 11+ people each drawing equally), the three biggest contributors are named.
