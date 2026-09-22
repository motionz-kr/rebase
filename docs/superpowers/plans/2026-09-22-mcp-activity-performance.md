# MCP activity list performance

## Goal

Keep the MCP activity page responsive as the local activity table grows past
100 events and query texts become large.

## Design

- Add a composite SQLite index for the activity list's workspace filter and
  descending timestamp order.
- Keep the activity list response lightweight by loading query text only when
  a row is expanded. The detail request still returns the complete stored SQL.
- Preserve existing metadata filtering, timing, and secret-redaction behavior.
- Add a regression test with a large activity table and an E2E check that the
  list renders a large set while the query detail is fetched on demand.

## Verification

- SQLite repository tests for indexed list queries and detail lookup.
- Renderer tests/build.
- Live Electron E2E with more than 100 MCP activity rows.
