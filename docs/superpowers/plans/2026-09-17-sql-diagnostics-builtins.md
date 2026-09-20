# SQL diagnostics built-in identifiers

## Goal

Prevent the query editor's lightweight table-reference diagnostics from reporting SQL built-in temporal values such as `CURRENT_TIMESTAMP` as missing tables.

Also ensure database/schema-level visibility choices in the connection editor are respected by the left schema explorer.

## Scope

- Add a regression test covering a table-reference-shaped occurrence of `CURRENT_TIMESTAMP`.
- Ignore standard SQL temporal/session built-ins during missing-table resolution.
- Add an Electron E2E assertion for the query editor diagnostics panel.
- Persist schema-level visibility separately from per-table visibility and filter hidden schemas from the explorer.

## Verification

- Run the focused renderer unit test with a failing-first check.
- Run the focused renderer unit test after the fix.
- Run the renderer test suite and build.
- Run the desktop build and the focused query diagnostics Playwright spec.
