# Capture and viewport

## Sub-features

Viewport crop bounds, known content pixels, omitted controls, stale-view rejection, and fresh native viewport priority.

## How to get to it (user POV)

Frame the board on the iPad and run `tldraw-ipad capture --output PATH`. Whole-page capture uses `--all`.

## Driving it with Playwright and the device runner

Run `pnpm verify --scenario capture`. It checks green shape pixels and an empty corner, viewport dimensions, an aged status response, and native priority at the HTTP boundary.

Run `pnpm ipad:verify --scenario render` and inspect both `ready-device.png` and `ready-canvas.png`.

## Gotchas

The stale-view scenario injects an aged HTTP response to exercise rejection without waiting. The canvas image is an SDK export, not a screenshot of WebKit.
