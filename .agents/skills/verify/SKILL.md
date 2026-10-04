---
name: verify
description: Verify tldraw-ipad changes with fast tests, isolated browser scenarios, or the paired physical iPad. Use for testing this project, reproducing canvas failures, and checking device behavior.
---

Run commands from the repository root. Use scripts for launching, polling, evidence, and cleanup. Read the short JSON report first. Open the named screenshot or log only when needed.

## Choose a check

- Run `pnpm test:fast` during logic changes. It starts no browser and calls no model provider.
- Run `pnpm verify --scenario capture`, `sync`, `restore`, or `ask` for a focused browser/CLI workflow. `pnpm verify --list` lists the maintained registry.
- Run `pnpm test` after sync, persistence, capture, CLI, Ask pi, or interaction changes. It builds once into an isolated directory and runs the full journey and focused regressions.
- Read [features/README.md](features/README.md) when choosing behavior coverage.

## Launch and doctor

Browser scenarios launch and close their own server and Chromium. Each server has temporary storage, a unique build, and both model runners scripted. They never use `data/`.

For ordinary board use, run `tldraw-ipad doctor`. For a scratch server, pass its explicit `--url`. Doctor reports server identity and viewport freshness. Missing viewport blocks current-view capture, but does not mean the server is broken.

Run `pnpm ipad:dev --scenario drawing` to open a scratch board on the paired iPad. The command builds and installs the host only when its native source changes. If several devices or LAN interfaces are eligible, supply `--device ID` or `--host LAN_IP`. Keep the command running in its foreground shell.

The command prints an absolute `session.json` path. Run `pnpm ipad:reload --session PATH` from another shell after web or server changes. It saves the board, builds a fresh frontend and backend snapshot, restarts only that session's server, and waits for matching instance, bundle, session, and document identities.

Use `--live-model` only for an explicitly requested provider check. Normal tests and device sessions use scripted replies. `pnpm ipad:install --device ID` forces a native rebuild/install without changing the saved canvas address.

## Drive the real iPad

Run `pnpm ipad:verify --scenario render` for automated launch, sync, loaded-build, and screenshot checks. It requires an unlocked paired iPad on the Mac network.

Run `pnpm ipad:verify --scenario pencil` when the operator can draw a stroke and tap Undo. Step instructions appear directly on the scratch board and show completion before closing. Do not launch another device session while an operator request is pending. Relay the end of the check before moving on. The script waits for actual pen input and checks the same stroke reaches the server and disappears on undo. `--timeout SECONDS` controls each physical checkpoint.

Run `pnpm ipad:verify --scenario gestures` when the operator can pan with one finger and pinch. The script checks the viewport changes without document edits. Pressure, palm rejection, responsiveness, and rotation remain separate unverified fields.

## Evidence and cleanup

Every run writes a unique `test-results/verify/RUN_ID/` directory. `report.json` gives checkpoint outcomes and artifact paths. Browser runs save screenshots, traces, console errors, document snapshots, and editable backups. Device runs save actual iPad screenshots, canvas exports, status, native logs, and editable backups.

A device screenshot proves displayed pixels. A canvas export proves document rendering. Neither proves unperformed Pencil or palm behavior. Report browser and physical results separately.

`pnpm ipad:stop --session PATH` ends an iPad development session and waits for its finalized report. Ctrl-C also ends it. The runner returns Canvas to its saved everyday address before preserving the final editable backup. If backup fails, it keeps scratch storage and reports its path. Cleanup affects only the session's server and temporary storage; evidence remains.

If a command fails, inspect its returned report rather than recreating the launch procedure manually. A failed reload ends the session with evidence. Start a new session after fixing the cause. Do not clear or restore the live board to test a change.
