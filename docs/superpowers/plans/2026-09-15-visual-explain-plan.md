# Visual EXPLAIN Plan

## Goal

Turn the existing query editor EXPLAIN action into a readable visual execution plan while preserving access to the driver's original result grid.

## Scope

- Generate a driver-appropriate, non-executing plan query for PostgreSQL, MySQL, and SQLite.
- Parse PostgreSQL JSON plans, MySQL JSON plans, and SQLite `EXPLAIN QUERY PLAN` rows in a pure renderer utility.
- Show plan operations as an expandable tree with useful estimated cost/row/access details.
- Keep an explicit Raw results view and fall back safely when a plan format is not recognized.
- Leave SQL Server and Redis behavior clearly unsupported for visual plans rather than misrepresenting output.
- Add unit tests and a desktop E2E flow using an isolated SQLite fixture.

## Design

The renderer owns display-only parsing and visualization. The engine continues returning its normal streamed columns and rows. A pure parser converts supported driver output into a driver-neutral tree; unrecognized payloads remain accessible in the existing result grid. EXPLAIN remains non-executing; do not add `EXPLAIN ANALYZE` in this change.

## Test plan

1. Add failing parser tests for nested PostgreSQL JSON, MySQL JSON, SQLite parent-child rows, and unknown formats.
2. Implement the smallest parser that passes those tests.
3. Add a tree component and integrate it with the existing EXPLAIN action, including raw-result switching and unsupported-driver feedback.
4. Run renderer unit tests, lint, build, desktop build, then the isolated SQLite EXPLAIN E2E flow.

## Acceptance criteria

- PostgreSQL, MySQL, and SQLite EXPLAIN runs display a visual plan when the response matches a supported format.
- Users can switch to the exact raw result grid at any time.
- Unknown payloads do not crash and remain available in raw form.
- No database-changing query is executed by the visual plan action.
- E2E proves the rendered SQLite plan against an isolated temporary database.
