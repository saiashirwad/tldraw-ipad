# Drawing and sync

## Sub-features

Stable-ID CLI updates, live sync, human undo/redo, and agent camera/revision neutrality.

## How to get to it (user POV)

Draw on Canvas or run `tldraw-ipad draw FILE.json` against the intended server.

## Driving it with Playwright and the device runner

Run `pnpm verify --scenario sync`. It executes the real CLI and uses mouse input and accessible Undo/Redo buttons.

Run `pnpm ipad:verify --scenario pencil` for a physical stroke and undo. The operator performs the input; the script observes pen release, loaded-device shape IDs, and persistent server records.

## Gotchas

CLI success proves server acknowledgement. It does not establish iPad display or physical input. Stable IDs help reconcile mutation retries.
