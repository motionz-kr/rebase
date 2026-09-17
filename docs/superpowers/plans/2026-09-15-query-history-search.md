# Query history search and status filtering

## Goal

Make saved execution history practical to scan by filtering the already-loaded history by query/title text and execution outcome.

## Scope

- Add pure, case-insensitive search over query text and generated/user-provided title.
- Add `All`, `Successful`, and `Failed` status filtering to the History library panel.
- Preserve existing load-into-editor behavior and profile isolation.
- Add renderer unit tests and an isolated desktop E2E assertion.

## Out of scope

- Engine/storage/API changes or server-side pagination.
- Changing which statements are written to history.
- Persisting search/filter preferences.

## Verification

1. Write failing unit tests for text and status combinations.
2. Implement a pure filter helper and connect it to the History component.
3. Run renderer tests, build, and lint.
4. Run the SQLite query-context E2E flow and verify search/status filtering in the actual app.
