# Schema Compare and Migration Draft

## Goal

Let users compare a selected SQL database with another database using the same driver, inspect structural differences, and draft additive migration SQL without applying it.

## Scope

- Start comparison from a database context menu; the current profile/database is the source and the user selects a compatible target profile/database.
- Support MySQL, PostgreSQL, and SQLite in the first slice. SQL Server is excluded until schema identity is reliably schema-qualified in its graph results.
- Compare tables, columns (type, nullability, primary-key flag, and default expression), secondary indexes (ordered columns and uniqueness), and foreign-key column mappings.
- Extend the existing schema-graph payload with index/default metadata; do not add a separate per-table IPC fan-out.
- Generate editable, copyable SQL for source-only tables, safe additive columns, and missing secondary indexes where the engine's existing DDL metadata allows it.
- Never apply generated SQL automatically. Do not emit DROP/ALTER statements for removals or changed definitions; clearly label these differences for manual review.
- Report unsupported migration details (including FK changes and non-null added columns without a known default) instead of silently generating unsafe SQL.

## Design

Schema inventory remains in the Go adapters and uses the existing `GetSchemaGraph` port/HTTP/IPC path. Index metadata is added to each SQL adapter's graph result. Renderer code contains a pure, tested diff and additive-DDL planner plus a modal for target selection, differences, and SQL review/copy.

Profile and database identifiers remain explicit throughout the flow. The destination is never executed or modified by comparison or SQL generation.

## TDD and verification

1. Add failing renderer tests for structural diff classification and additive-only SQL generation.
2. Extend schema graph index metadata in the adapters and add adapter tests, starting with SQLite fixture coverage.
3. Add failing desktop E2E coverage using two temporary SQLite files; verify differences, generated SQL, and that generating a draft does not modify the destination.
4. Implement the database-context entry and comparison dialog.
5. Run engine unit tests, renderer unit tests/lint/build, desktop build, then the isolated Electron E2E flow with the verified elevated launcher when needed.

## Acceptance criteria

- Same-driver source/target selection loads both inventories and shows added, removed, and changed structures.
- Draft SQL is editable/copyable and includes only supported additive changes.
- Destructive or unsupported differences are visible but do not produce executable destructive SQL.
- Comparing and drafting SQL leave both databases unchanged.
- Unit and desktop E2E tests pass.
