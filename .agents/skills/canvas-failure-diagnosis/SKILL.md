---
name: canvas-failure-diagnosis
description: Diagnose tldraw-ipad sync, viewport, capture, model, input, or reload failures from compact verification reports and targeted reproductions. Use when this project's automated or physical checks fail.
---

Start with the returned `report.json`. It names the failed checkpoint and relevant artifacts. Read the specific log or image before attempting another mutation. Use [the verification skill](../verify/SKILL.md) for commands and isolation policy.

- For setup or rendering failure, inspect the browser log and screenshot or actual device screenshot. A missing ready heartbeat can mean a startup exception, an old bundle, another server, hidden app, or disconnected sync. Compare instance, build, session, document load, and timestamps.
- For capture failure, run `tldraw-ipad doctor --url URL`. Separate server readiness from viewport freshness. Current-view capture needs a fresh visible human view; `--all` uses the whole page and is not an equivalent answer to “look at my iPad.”
- For sync/CLI failure, use `pnpm verify --scenario sync`. Preserve stable IDs. `OUTCOME_UNKNOWN` means inspect status and capture before retrying; it does not establish that nothing changed.
- For clear/restore failure, use `pnpm verify --scenario restore` on a scratch board. `REVISION_CHANGED` requires a new editable backup of the current board before an authorized replacement.
- For Ask pi failure, use `pnpm verify --scenario ask` for streaming/history and `pnpm test:fast` for prompt/RPC logic. Default checks inject both runners. Their success does not prove the live provider works.
- For question-mark input failure, run `pnpm test:browser --match 'fast hook|recognition|input|candidate|remote sync'`. Inspect the failed run's trace and saved ink. Recognition rejection and interruption must preserve ink; one undo must restore the exact original strokes.
- For reload failure, inspect the session's reload result and native logs. The runner binds requests to the exact instance and session, saves before restarting, and ends a failed session. Start another scratch session after fixing the cause.

Keep reproduction on the same kind of client that failed. Chromium/CDP can reproduce input timing and SDK history; it cannot establish physical Pencil pressure or palm rejection. Convert a demonstrated failure into a focused regression at its actual boundary. Avoid tests that only match implementation text.
