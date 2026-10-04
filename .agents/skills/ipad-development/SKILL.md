---
name: ipad-development
description: Develop and inspect tldraw-ipad on the paired physical iPad, reload changed code, and collect device evidence without using the everyday board. Use for real-device testing and the local iPad development loop.
---

Use this project's scripts from the repository root. Read [the verification skill](../verify/SKILL.md) for evidence levels and physical acceptance requirements.

1. Run `pnpm ipad:dev --scenario drawing` for a blank scratch board, or `--scenario ask` for a prepared diagram. Default replies are scripted. Use `--live-model` only when a provider check is requested.
2. Keep that process running. Use the absolute session path it prints. After web or server edits, run `pnpm ipad:reload --session PATH` from another shell.
3. Read the reload result. A pass requires a fresh document from the expected compiled bundle and server instance. Do not substitute client count or an `ipad` source label for that result.
4. End with `pnpm ipad:stop --session PATH`, which waits for the final report, or Ctrl-C. The runner returns the app to its saved address, saves the final editable content, and closes only the owned scratch server. Evidence remains under the printed run directory.

Native source changes require installation. The development command detects them. `pnpm ipad:install` forces installation separately. Do not rebuild the native host for ordinary web reloads.

The device must be paired, unlocked, in Developer Mode, and on the Mac network. `--device ID` selects among several iPads. `--host LAN_IP` selects among several usable interfaces. Link-local USB interfaces are excluded from automatic LAN selection.

The app's `--verification-url` is transient and preserves query tokens. `--canvas-url` changes its everyday saved address, so use verification commands for tests. HTTP LAN pages lack secure-context APIs such as `crypto.randomUUID`. The document identity uses `getRandomValues`, and the sync scenario tests that constraint.

For an automated rendering check, run `pnpm ipad:verify --scenario render`. Run the pencil or gestures scenario only when the human can perform the actual action. Instructions change directly on the scratch board. Tell the human it will close when the check ends. Keep that session active until completion; do not interleave reload checks or another device launch while a physical request is pending. Relay that the check ended before moving on. Instruction updates wait for the visible client heartbeat, not only CLI server acknowledgement. Inspect the actual device PNG as well as the canvas export. Leave pressure, palm rejection, responsiveness, and rotation unverified without physical observations.
