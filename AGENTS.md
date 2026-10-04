# Working on tldraw iPad

This is one browser canvas shared by a human and coding agents. Keep the editor and sync protocol in the tldraw SDK. Local Node storage and a globally installed CLI are the adapters.

Read README.md for the workflow and limitations. Use `skills/tldraw-ipad/SKILL.md` before operating the board.

Keep the UI to the canvas, undo/redo, and tucked-away drawing controls. Preserve the SDK's license UI. Keep the current human viewport separate from short-lived agent clients. Agent identity is stable so opening a CLI session does not add a fresh user record and invalidate revisions.

Clear/restore replace user work: preserve an editable backup and require the current revision. Keep restore validation before live mutation. Captures exclude controls and use the latest visible human view; backups retain editable content and embedded images.

Run `pnpm test` for sync, persistence, capture, CLI, or interaction changes. It uses isolated storage. For the iPad host, build/install with `scripts/run-ipad.sh` and inspect the actual device. A browser test or screenshot does not establish physical Pencil/Safari behavior; report that verification separately. Keep scope to drawing back and forth; voice and annotation workflows belong outside this project.
