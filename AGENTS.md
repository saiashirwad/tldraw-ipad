# Working on tldraw iPad

This is one browser canvas shared by a human and coding agents. Keep the editor and sync protocol in the tldraw SDK. Local Node storage and a globally installed CLI are the adapters.

Read README.md for the workflow and limitations. Use `skills/tldraw-ipad/SKILL.md` before operating the board.

Use `.agents/skills/verify/SKILL.md` when testing or reproducing behavior. Prefer its scripts over manual launch/poll/capture sequences. Run `pnpm test:fast` for iteration, `pnpm verify --scenario NAME` for a focused check, and the complete `pnpm test` before reporting interaction changes verified. Each verification run owns an isolated board, build, and artifacts. Read the short report first and open relevant failure artifacts.

Use `pnpm ipad:dev` for a scratch session on the physical iPad. Its session file is the target for `pnpm ipad:reload --session PATH`. Use `pnpm ipad:verify --scenario render`, `pencil`, or `gestures` for device evidence. Physical input is performed by the human; unperformed checks remain unverified. Normal verification scripts inject both model runners; live provider checks require `--live-model`.

Use `.agents/skills/ipad-development/SKILL.md` for the local device loop and `.agents/skills/canvas-failure-diagnosis/SKILL.md` for failure triage. Keep reusable steps in scripts and these skills instead of reconstructing them in agent context.

Keep the UI to the canvas, undo/redo, and tucked-away drawing controls. Preserve the SDK's license UI. Keep the current human viewport separate from short-lived agent clients. Agent identity is stable so opening a CLI session does not add a fresh user record and invalidate revisions.

Clear/restore replace user work: preserve an editable backup and require the current revision. Keep restore validation before live mutation. Captures exclude controls and use the latest visible human view; backups retain editable content and embedded images.

Handwritten question marks trigger answers after the drawing pointer lifts and an idle pause. In pen mode, resting touch contacts do not delay or cancel answers. Keep the model tool-free and replace only confirmed marker ink after a complete answer, in one undoable SDK operation. The standalone iPad app runs Pi Durable locally with native private storage and a Keychain-backed DeepSeek network adapter. Explicit LAN mode retains the server runner. Agent clients never run automatic recognition.

Run `pnpm test` for sync, persistence, capture, CLI, Ask pi, or interaction changes. It uses isolated storage. For the iPad host, build/install with `scripts/run-ipad.sh` and inspect the actual device. A browser test or screenshot does not establish physical Pencil/Safari behavior; report that verification separately. Keep scope to drawing back and forth; voice and annotation workflows belong outside this project.
