# Editable backups

## Sub-features

Embedded assets, editable shapes, guarded board replacement, invalid restore rejection, and SQLite restart persistence.

## How to get to it (user POV)

Use backup before an authorized clear/restore. Supply the current revision for replacement.

## Driving it with Playwright and the CLI

Run `pnpm verify --scenario restore` for independent guard and restore checks. Run `pnpm test` for image embedding and server restart coverage in the full journey.

## Gotchas

Run these on scratch boards. A PNG is not an editable backup. Device teardown preserves the `.tldr` or retains scratch storage when backup fails.
