# tldraw iPad

One shared canvas for you and coding agents. Open it in iPad Safari, draw with Pencil, and ask an agent to look at your view or put something beside your drawing. Shapes, handwriting, and images are editable tldraw content, synced live and saved on your Mac.

This is a small remake of MyPad: React + the tldraw SDK, one Node server, an agent CLI, and a thin iPad WebView app. No voice, pinned annotations, chat, accounts, board library, or hosted AI service.

## Run

Requires Node 24+ and pnpm. Keep the Mac running and the iPad on the same local network.

```sh
cd ~/code/tldraw-ipad
pnpm install
pnpm browser:install
./scripts/install.sh
pnpm dev
```

The server prints a local-network URL such as `http://192.168.0.105:4789`. Open that URL in Safari on your iPad, or use the installed **Canvas** app. If the Mac firewall asks, allow Node's incoming connections. The app listens on port 4789; `PORT=5000 pnpm dev` changes it.

Pencil draws on touch devices; drag one finger to pan and pinch two fingers to zoom. Finger panning pauses while the Pencil is down. On the Mac, a mouse draws and the trackpad navigates. Undo/redo sit at bottom left; the pen button opens pen, eraser, selection, and style controls. Choose Fine or Hairline for a constant-width pen, then adjust Pen width from 0.1 to 2 canvas units for writing while zoomed in. Standard keeps tldraw's pressure-sensitive brush and size presets. New strokes keep their width across clients and exports; changing the pen leaves existing ink alone. The last camera and pen width are saved per browser. Everything starts tucked away.

The Mac stores the board in `data/board.sqlite` and images in `data/assets/`. Both belong to the board. `DATA_DIR=/some/path pnpm dev` changes the storage location. This is an unauthenticated app for your trusted local network; keep it off the public internet. The SDK may fetch its fonts and icons from tldraw's CDN.

## Install the iPad app

The app named **Canvas** is a separate install (`in.texoport.tldrawipad`). Its single Swift file hosts the same tldraw page in WebKit, saves the server address, and lets you reconnect when the address changes. It has no drawing or sync implementation of its own.

With Xcode installed and an unlocked, paired iPad with Developer Mode enabled:

```sh
./scripts/run-ipad.sh DEVICE_UDID http://YOUR_MAC_IP:4789
```

The project uses the same development team as this machine's MyPad project; change `DEVELOPMENT_TEAM` in the Xcode project for another developer account. On first launch, allow local-network access if iOS asks. Keep the Mac server running while using Canvas. If it cannot load, the app offers a server-address field and Connect button. Browser-only installation is also possible with Safari's **Share → Add to Home Screen**.

## Agents

The installer makes `tldraw-ipad` available from any repository and installs its agent skill. Restart agent sessions to discover the new skill. The server must be running; the iPad only needs to be open for a capture of its current view.

```sh
tldraw-ipad status
tldraw-ipad draw ~/code/tldraw-ipad/examples/diagram.json
tldraw-ipad put ./wireframe.svg
tldraw-ipad capture --output ./feedback.png
tldraw-ipad capture --all --output ./whole-page.png
tldraw-ipad backup --output ./board.tldr
tldraw-ipad clear --if-revision REVISION_FROM_BACKUP
tldraw-ipad restore ./board.tldr --if-revision CURRENT_REVISION
```

Commands return JSON. Agents must open the returned capture `image` path with their image-reading tool. Capture exports the latest visible view's page bounds, excluding controls and cursors. A live native iPad view takes priority over Mac browser previews. It rejects views older than 15 seconds; `--all` captures the entire current page without an open iPad. Keep just one human browser tab open when framing feedback through Safari. The current view updates every half second.

`draw` takes an array of [tldraw shape partials](https://tldraw.dev/docs/editor). A stable `shape:...` ID updates an existing shape. Omit the ID to add a new one. An optional top-level `text` field becomes the SDK's rich text. Coordinates use canvas units; obtain the visible bounds with `status`. Edits add to the board and leave other content in place.

```sh
echo '[{"id":"shape:idea","type":"geo","x":100,"y":100,"text":"Try this","props":{"geo":"rectangle","w":240,"h":120,"color":"blue"}}]' | tldraw-ipad draw -
```

`put` accepts PNG, SVG, JPEG, GIF, and WebP up to 25 MiB. It centers the image in the latest view by default; `--x`, `--y`, and `--width` set its canvas frame. The SDK decodes it and stores it as an image asset.

Backups are standard `.tldr` files with editable shapes, ink, and embedded images. Save one before replacing the board. Clear and restore reject stale revisions. A timeout can leave an unknown outcome: inspect status/capture before retrying. A capture is a picture, not an editable backup. Clear retains image files on disk; storage cleanup is intentionally manual.

Set `TLDRAW_IPAD_URL` or use `--url` to point the CLI at a different host. The CLI runs a short-lived headless Chromium connected through tldraw sync: the SDK supplies shape defaults, image decoding, and PNG rendering. A draw/put command reports success after the persistent server acknowledges its shapes.

## Ask pi while you draw

Write a question mark with a separate hook and dot beside your handwritten question, then pause for about one second. The app checks the isolated mark with a separate vision recognizer and replaces only those strokes with a short answer at the same position. The mark stays until recognition and the entire answer succeed. New writing cancels pending work and retries an intact mark after the next pause. One undo restores the exact mark and removes the answer; redo restores the answer. Ambiguous marks, failed requests, and unfinished answers leave the ink alone. Unchanged marks do not repeatedly ask. The **⌄** panel contains **Answer handwritten ? after a pause**, enabled by default and saved for that browser. Automatic recognition uses only new local drawing, so synced ink and undo do not start requests.

Tap **Ask pi** at the bottom right, beside the pen, and the current viewport goes to a pi agent as a screenshot: your drawing and handwriting, not the whole board. The answer streams back into one small, editable text shape beside the visible handwriting, avoiding existing ink and replies. Select part of the drawing to use it as the anchor; without a selection, visible handwriting takes priority over other shapes. Old offscreen answers don't push new replies away. The camera stays put when both fit, and otherwise frames just the writing and reply. Tap **Stop** to end an answer early; the text written so far stays. One undo removes the whole reply.

The `⌄` button opens an optional typed question and four reply styles: **Brief answer** (default), **Hint**, **Next step**, and **Check my work**. Handwriting is treated as your message, not a penmanship sample: questions get answers, unfinished equations get completed, greetings get normal replies, and ideas get one concrete next step. Letter shapes and stroke quality are not reviewed unless you ask. Replies are usually 2–12 words, one short sentence at most (maximum 25 words). The server stops replies at 180 characters even if the model ignores the prompt; a clipped reply ends in `…`. Ask again for more. Edit the presets in `src/ask-prompts.ts` and the base instructions in `pi.ts`.

The server keeps one long-lived `pi --mode rpc` process on `deepseek/deepseek-flash`, so the conversation carries across asks: draw, ask, refine, ask again. It runs with no tools and no project context, so it reads the screenshot and talks but cannot touch files or the board itself. Set `TLDRAW_IPAD_PI` to another pi binary or `TLDRAW_IPAD_MODEL` to another model. The control is hidden from `?agent=1` clients.

## Build and verify

```sh
pnpm check
pnpm test
pnpm build
pnpm start
```

`pnpm test` builds once in its own directory and runs the full browser/CLI round trip, focused scenarios, and logic tests. It covers live sync, drawing, touch navigation, undo/redo, palette, capture pixels and bounds, images, editable backup/restore, revision guards, invalid restore, streamed replies, automatic question-mark input and cancellation, and server restart. Both model runners are scripted. Tests never use `data/`.

Use these commands while developing:

```sh
pnpm test:fast
pnpm verify --list
pnpm verify --scenario capture
pnpm verify --scenario sync
pnpm verify --scenario restore
pnpm verify --scenario ask
pnpm test:browser
pnpm test:browser --match 'recognition|input'
```

Fast tests require no frontend build, browser, or model account. Focused scenarios start fresh boards and exercise the same functions used by the test suite. `pnpm test:browser` runs browser regressions and the full round trip without the logic tests.

Each run prints a short result and an absolute `report.json` path under `test-results/verify/`. Browser reports link screenshots, a Playwright trace, console/request errors, document snapshots, and editable backups. Build and test output stays in log files. Evidence survives cleanup. `tldraw-ipad doctor` checks Node, Chromium, server identity, and current-view freshness without opening a browser.

## Develop on the real iPad

```sh
pnpm ipad:dev --scenario drawing
pnpm ipad:dev --scenario ask
```

The command selects the connected paired iPad, creates a scratch board on a separate LAN port, and opens it in Canvas. It installs the host when native source changes and reuses the install for web changes. Supply `--device ID` or `--host LAN_IP` if device or network selection is ambiguous. Model replies are scripted unless you pass `--live-model` for a provider check.

Keep the command running. It prints a session file path. After editing web or server code, use another shell:

```sh
pnpm ipad:reload --session /absolute/path/session.json
```

Reload saves an editable backup, builds fresh frontend and backend source, restarts only the scratch server, and relaunches Canvas. It waits for the expected server instance, compiled bundle, session token, document load, and sync state. The scratch board stays intact. A test URL never overwrites the app's saved everyday address.

`pnpm ipad:stop --session /absolute/path/session.json` ends the owned session and waits for the final report. Ctrl-C also ends it. The runner returns Canvas to its everyday address before saving the final scratch board. If backup fails, the runner retains scratch storage and reports its path. `pnpm ipad:install --device ID` forces a native build/install separately.

## Check physical behavior

```sh
pnpm ipad:verify --scenario render
pnpm ipad:verify --scenario pencil
pnpm ipad:verify --scenario gestures
```

The render scenario checks the loaded build, a known shape, and the actual device screenshot. Pencil shows instructions directly on the scratch board, waits for you to draw a stroke, then changes its instruction to tap Undo. Completion or failure is shown before the board closes. It checks actual pen release, synced ink, and removal of the same stroke. Gestures shows one-finger pan and pinch instructions in sequence, then checks viewport changes without document edits. Each physical checkpoint has a two-minute timeout; `--timeout SECONDS` changes it.

Device reports include actual iPad PNGs, SDK canvas exports, status snapshots, native logs, and editable backups. Pressure, palm rejection, responsiveness, and rotation remain explicitly unverified until a dedicated physical acceptance pass. A successful browser test or device launch does not prove those interactions.

Agents use [.agents/skills/verify/SKILL.md](.agents/skills/verify/SKILL.md) to select checks and interpret evidence. Its feature map covers drawing, capture, storage, Ask pi, and the native host.

The app was built, installed, and launched on the paired physical iPad. The device connected over the LAN, handwriting appeared in an agent capture, and an agent response synced back to the device. An editable backup of that first session is saved locally in `data/first-ipad-session.tldr`. The new verification runner has also checked a real Pencil stroke and its Undo on the device. Pencil pressure, palm rejection, multi-touch gestures, rotation transitions, and Home Screen behavior have not received a dedicated interaction acceptance pass. Safari on the Mac can also be used for manual review.

## tldraw license

The SDK is source available. [Production use requires a tldraw license key](https://tldraw.dev/community/license). Development works without one; the SDK may display its license notice. To supply a key, create `.env.local` with `VITE_TLDRAW_LICENSE_KEY=your-key`, then restart development or rebuild. The app preserves the SDK's license UI.

## Small code map

- `src/main.tsx`: tldraw sync, Pencil mode, two corner controls, and view reporting.
- `src/ask.tsx`: the Ask pi control, the screenshot upload, and streaming the answer into a shape.
- `src/auto-ask.ts`: local drawing ownership, idle recognition, cancellation, and undoable question-mark replacement.
- `src/question-mark.ts`: geometric candidate filtering and conservative vision recognition.
- `src/ask-placement.ts`: nearby, non-overlapping reply placement using visible ink or the selection.
- `src/ask-prompts.ts`: short-note rules and the four reply presets shared by browser and server.
- `pi.ts`: the long-lived `pi --mode rpc` child that answers with a vision model.
- `src/agent.ts`: SDK operations for shapes, images, captures, and editable files.
- `server.ts`: one sync room, SQLite persistence, assets, and revision-guarded replacement.
- `scripts/cli.mjs`: agent command and headless editor lifecycle.
- `ipad/Canvas.swift`: iPad WebView host and connection recovery.
