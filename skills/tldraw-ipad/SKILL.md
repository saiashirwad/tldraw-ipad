---
name: tldraw-ipad
description: Read or draw on the user's shared tldraw iPad canvas, place diagrams and images, or inspect visual feedback when they refer to the tldraw iPad app or ask to use its canvas.
---

Use the installed `tldraw-ipad` CLI from any directory. This is the browser canvas in `~/code/tldraw-ipad`; native MyPad uses a separate `mypad` command. The local server must be running. If it is down, start `pnpm dev` in `~/code/tldraw-ipad` and give the user the printed iPad URL.

Run `tldraw-ipad doctor` when connection or capture setup is unclear. It checks Node, Chromium, server identity, and viewport freshness without opening an agent browser. For project testing, use `~/code/tldraw-ipad/.agents/skills/verify/SKILL.md` and its isolated scripts.

Run `tldraw-ipad status` to find the current view and revision. For “look at my iPad,” run `tldraw-ipad capture --output /absolute/path/feedback.png`, then open the returned `image` path with your image-reading tool. Completion means you have inspected the pixels. If the view is absent or stale, ask the user to open the canvas; use `capture --all` only when they want the whole page.

To draw, write a JSON array of tldraw shape partials and run `tldraw-ipad draw /absolute/path/shapes.json`. Use the reported view's canvas coordinates. For example:

```json
[
  {"id":"shape:agent-idea","type":"geo","x":100,"y":100,"text":"Try this","props":{"geo":"rectangle","w":240,"h":120,"color":"blue"}},
  {"type":"arrow","x":360,"y":160,"props":{"start":{"x":0,"y":0},"end":{"x":160,"y":0}}}
]
```

Stable IDs update your existing shapes; omitted IDs create new ones. `text` becomes rich text. Place image references with `tldraw-ipad put /absolute/path/image.svg` (also PNG/JPEG/GIF/WebP); optional `--x`, `--y`, `--width` use canvas units. Images center in the current view by default. Capture afterward and inspect the result before reporting it placed correctly.

Keep user drawing intact when responding. Before an authorized clear or restore, save an editable file with `tldraw-ipad backup --output /absolute/path/board.tldr`. Use its returned revision for `clear --if-revision N`. Restore uses `tldraw-ipad restore /absolute/path/board.tldr --if-revision N` and replaces the board; preserve the current board first. If drawing changes the revision, take a new backup before retrying.

Commands return JSON. A timeout has an unknown outcome: inspect status/capture before repeating a mutation; stable shape IDs help reconcile edits. `--url` or `TLDRAW_IPAD_URL` selects the server. See `tldraw-ipad --help` for the command reference. Report browser/build checks and physical iPad checks separately.
