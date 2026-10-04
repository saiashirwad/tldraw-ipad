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

## Build and verify

```sh
pnpm check
pnpm test
pnpm build
pnpm start
```

`pnpm test` builds the app and runs an isolated browser round trip: live sync, drawing, undo/redo, palette, current-view PNG capture, images, editable backup/restore, revision guards, malformed restore rejection, and a server restart. It never touches `data/`. Preview artifacts land in `test-results/`.

The app was built, installed, and launched on the paired physical iPad. The device connected over the LAN, handwriting appeared in an agent capture, and an agent response synced back to the device. An editable backup of that first session is saved locally in `data/first-ipad-session.tldr`. Pencil pressure, palm rejection, multi-touch gestures, rotation transitions, and Home Screen behavior have not received a dedicated interaction acceptance pass. Safari on the Mac can also be used for manual review.

## tldraw license

The SDK is source available. [Production use requires a tldraw license key](https://tldraw.dev/community/license). Development works without one; the SDK may display its license notice. To supply a key, create `.env.local` with `VITE_TLDRAW_LICENSE_KEY=your-key`, then restart development or rebuild. The app preserves the SDK's license UI.

## Small code map

- `src/main.tsx`: tldraw sync, Pencil mode, two corner controls, and view reporting.
- `src/agent.ts`: SDK operations for shapes, images, captures, and editable files.
- `server.ts`: one sync room, SQLite persistence, assets, and revision-guarded replacement.
- `scripts/cli.mjs`: agent command and headless editor lifecycle.
- `ipad/Canvas.swift`: iPad WebView host and connection recovery.
