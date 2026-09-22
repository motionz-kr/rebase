# MCP full result delivery

## Goal

Return MCP tool results unchanged so external AI clients can use actual query
data and execution plans, including the full output of `explain_query`.

## Scope

- Remove MCP-only row/result withholding from `run_select`, `explain_query`,
  and `profile_table`.
- Keep MCP access-scope validation, read-only execution, and credential secret
  redaction in place.
- Remove the MCP UI selector that implies results can be metadata-only, and
  explain that result values are returned to the connected local client.
- Keep the separate in-app agent data-exposure policy unchanged.
- Update security/product documentation and tests.

## Verification

- Add/adjust MCP adapter tests proving `EXPLAIN` and row values are preserved.
- Run focused Go tests, full engine tests, renderer tests, and builds.
- Run the direct MCP stdio path with an `EXPLAIN`-like result and verify the
  returned payload is not replaced by a `withheld` summary.
