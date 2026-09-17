# Query editor diagnostics

## Goal

Show lightweight, actionable SQL diagnostics directly in the query editor so
syntax/context problems are visible before execution, while keeping server
execution errors tied to the existing statement block markers.

## Scope

- Add a pure renderer diagnostic module with tests for unclosed literals,
  unbalanced parentheses, unknown tables, and qualified unknown columns.
- Use the active tab's schema context to create Monaco markers with line/column
  ranges and hover messages.
- Add a compact toolbar summary and an editor diagnostics list that can focus
  the corresponding line.
- Keep diagnostics advisory: do not block Run, because dialect-specific SQL and
  incomplete text are common while typing.
- Preserve runtime error handling and existing statement execution markers.
- Add isolated SQLite Playwright coverage for visible diagnostics and runtime
  error line feedback.

## Verification

1. RED/GREEN unit tests for the pure diagnostic classifier.
2. Renderer and desktop builds/tests.
3. Electron Playwright flow against a temporary SQLite database.
4. Inspect a captured screenshot of an inline diagnostic.
