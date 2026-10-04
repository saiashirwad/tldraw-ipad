# Ask pi

## Sub-features

Streaming, brief prompts, placement, Stop, one-answer undo, recognition, and preserved ink on cancellation/rejection.

## How to get to it (user POV)

Tap Ask pi or write a separate hook and dot with automatic asking enabled.

## Driving it with Playwright

Run `pnpm verify --scenario ask` for the streamed-answer workflow. Run `pnpm test:fast` for prompts, geometry, recognition, and scripted RPC. Run `pnpm test:browser` for local input, cancellation, rejection, exact undo, and remote non-trigger regressions.

## Gotchas

Both model runners are scripted. These checks prove integration behavior, not provider quality. Use `pnpm ipad:dev --scenario ask --live-model` only for an explicitly requested provider check.
