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
- **Pen** (very thin to very thick, size 1-100), **Eraser**, soft **Brush**, **Airbrush**, **Chalk** and **Highlighter**, each with its own size and opacity. Pen pressure is used when the device reports it.
- **Bucket** fill (lines stop it even when they are thin or soft, and gaps up to about 4 px in an outline are closed, so finger-drawn shapes hold the colour), **Pick colour** (eyedropper), and **Line / Rectangle / Ellipse** (outline or filled).
- **Layers** (up to 8): add, hide, reorder, rename, delete, per-layer opacity and blend mode (normal, multiply, screen, overlay, darken, lighten). They sync live in a shared room.
- **Mirror tool** 🪞: drag across the canvas to place dotted mirror lines anywhere, at any angle (it snaps to straight and 45° when you are close). Whatever you draw with the pen, brushes, eraser or shapes is mirrored across every line, so two lines give four copies and three give eight. Tap a line to remove it; the *Mirror* button in the options row switches it on and off. The lines are stored with each stroke, so everyone in a shared drawing sees the same thing, and older drawings made with the fixed centre mirror still draw the same. Stroke **smoothing**, undo / **redo**, **pinch to zoom / pan** and a **rotate** button (quarter turns, view only; *Fit* resets the view).
- **Colours:** 12 quick slots plus a full colour picker (colour square + hue) that remembers your recent colours. **Clear the whole drawing** lives in the Canvas panel.
- The Mini App turns off Telegram's swipe-down-to-minimise gesture (`disableVerticalSwipes`), so a downward stroke does not minimise the app.
- Everything drawn is a list of operations (`stroke`, `fill`, `shape`), each tagged with its layer; the server validates every operation before relaying it. Drawings made with the old Pencil / Marker tools still draw the same.

## Private chats (DMs)
Writing to the bot in a DM (or pressing its **🎨 Draw** menu button) goes straight to a one-person canvas: no alone/together choice. The finished picture is sent back to that DM. This uses a `web_app` button, so it needs no BotFather setup. The page is served from `WEBAPP_URL` (defaults to the GitHub Pages site; set the env var on Render to use another host).

## Saving your progress
- **Alone:** the drawing is saved on your phone a moment after every change and comes back when you reopen the same canvas (7 days after the last change, or until you clear it). The DM canvas is one persistent canvas per person.
- **Shared:** the server keeps the drawing while it is awake. If it forgot it (free Render sleeps when idle), the first person to come back sends their saved copy and the room is rebuilt for everyone. User records are signed by the server, so a restored drawing cannot be used to invent names in the credits.
- Rooms that nobody has entered for 24 hours are dropped from server memory.

## Limits
- A shared room holds **12 people** at once (`MAX_PEOPLE` env var) and **3000 operations** (strokes, fills, shapes). People are told when a drawing is full.

## Who is named in "Drawn by"
In a shared drawing a person is named if they drew at least **10 for every 90** that the biggest contributor drew (`CREDIT_MIN_PERCENT`), biggest first. The test is relative to the leader, so it means the same thing with 2 or 12 people: with two people it works out to about 10% of the picture, and with 12 people a few small touches next to a big drawing still don't count, while 12 people who each drew a fair part are all named. Someone who drew nothing (only erased, moved things, or pressed Finish) is never named.
The amount is measured as area of ink: strokes by length x width, shapes by outline (plus area when filled), a bucket fill counts as a fixed chunk; erasing counts for nothing. Undoing your strokes lowers your amount.

## When the bot does not answer
Open `https://<your-service>.onrender.com/status`. It shows only yes/no facts: `botStarted`, `webhookSet`, `publicUrlSet`, `miniAppShortSet`, `updatesReceived` (messages Telegram has delivered since the server started) and `lastError`. If `publicUrlSet` is false the webhook was never registered (set `PUBLIC_URL` on Render); if `webhookSet` is true but `updatesReceived` stays 0 after you message the bot, Telegram cannot reach the server.

## Drawing together: open and closed groups
- `/draw` in a group shows **Draw alone** and **Draw together**. **Draw together** asks **🔓 Open group** or **🔒 Closed group**, then the bot posts a message with a **🎨 Join active session** button. Later `/draw` messages show that button too (for 12 hours).
- **Open:** anyone who taps the button joins straight away.
- **Closed:** the host (whoever chose "Closed") walks in. Everyone else sees a waiting screen, and the people already drawing get "<name> wants to join: Let in / Decline". Any member can answer. People who were let in get a signed pass stored on their phone, so they can come back (even after the server restarts) without asking again. At most 10 people can wait at the door.
- The open/closed choice and the host are part of the signed link, so a link cannot be edited to change them.
- Inside a shared drawing, **➕** (with the number of people, and a lock for closed groups) shares the invite link via Telegram or copies it.
