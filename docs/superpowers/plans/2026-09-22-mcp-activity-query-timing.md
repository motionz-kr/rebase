# MCP activity query and timing details

## Goal

Make the MCP activity view useful for diagnosing tool failures by showing the
actual SQL sent to the database and the elapsed time for each recorded event.

## Design

- Add an optional query-text field to the persisted MCP activity event and
  migration, while retaining existing activity rows.
- Trace every SQL statement executed through the MCP read-tool query path.
  This captures generated SQL (including `EXPLAIN` and `table_stats`) rather
  than only the tool input.
- Attach the trace to the tool-call activity record and redact configured
  connection secrets before persistence.
- Extend the repository, HTTP/IPC types, and renderer detail panel to show
  query text and elapsed time. Keep non-SQL lifecycle events usable with an
  empty query field.
- Update focused Go and renderer tests, then run the desktop app and verify the
  MCP activity page by opening an event and checking query text and duration.

## Verification

- Go unit tests for query tracing and SQLite activity persistence.
- Renderer type/build/lint checks.
- Playwright/CDP live UI verification through the actual desktop app.
