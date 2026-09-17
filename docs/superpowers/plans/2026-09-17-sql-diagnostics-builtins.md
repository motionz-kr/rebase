# SQL diagnostics built-in identifiers

## Goal

Prevent the query editor's lightweight table-reference diagnostics from reporting SQL built-in temporal values such as `CURRENT_TIMESTAMP` as missing tables.

## Scope

- Add a regression test covering a table-reference-shaped occurrence of `CURRENT_TIMESTAMP`.
- Ignore standard SQL temporal/session built-ins during missing-table resolution.
- Add an Electron E2E assertion for the query editor diagnostics panel.

## Verification

- Run the focused renderer unit test with a failing-first check.
- Run the focused renderer unit test after the fix.
- Run the renderer test suite and build.
- Run the desktop build and the focused query diagnostics Playwright spec.

