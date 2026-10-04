# iPad host

## Sub-features

Native install, transient URL, preserved query token, loaded bundle readiness, scratch reload, screenshots, and physical gestures.

## How to get to it (user POV)

Open Canvas. Verification commands select and launch the paired iPad directly.

## Driving it with devicectl

Run `pnpm ipad:verify --scenario render`. Use `pnpm ipad:dev` for an interactive scratch session and `pnpm ipad:reload --session PATH` after changes. Run pencil and gestures scenarios while the operator is available. Instructions update directly on the scratch board, including completion. Keep the device session active until the check ends and tell the operator it has ended before opening another one.

## Gotchas

Native source changes rebuild the host; web reloads reuse it. A `source: ipad` label alone is insufficient. The runner compares session, server instance, compiled bundle, document load, and sync. Developer Mode, pairing, LAN access, and an unlocked device are required.
