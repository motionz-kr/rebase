# Query shortcut after running a query

## Goal

Keep Cmd/Ctrl+Enter able to rerun the final SQL statement when the caret is at
the end of the editor after a query has run.

## Scope

- Reproduce the run → place caret at the end after a trailing semicolon →
  Cmd/Ctrl+Enter flow in an isolated desktop E2E test.
- Treat the trailing semicolon and whitespace after the final statement as part
  of the final statement's caret range, including comment-only tails.
- Preserve the existing behavior for selections and empty gaps between
  statements.

## Validation

- [x] Run the `sqlExecutionTarget` unit tests; the trailing-semicolon case
  failed before the fix and passes after it.
- [x] Build the renderer and desktop main process.
- [x] In Playwright/Electron with a disposable SQLite DB, run a query once and
  rerun it with Cmd/Ctrl+Enter at the end of the input.
- [x] Cover line, block, and hash-comment tails after a statement terminator
  with unit regressions and a line-comment Electron E2E.
- [x] Rerun the `SELECT*` write-permission regression E2E.
