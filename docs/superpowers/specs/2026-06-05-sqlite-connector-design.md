# SQLite Connector — Design

**Milestone:** #5 Database engine expansion (Epic #34) — first sub-project.
**Goal:** Make SQLite a fully connectable database with the same feature parity as the existing MySQL/PostgreSQL engines: connect, browse schema (tables/views/indexes/foreign keys), run read & write queries, inline-edit table data, view the ER diagram, and run multi-statement batches.

**Scope:** SQLite only. SQL Server and MongoDB are separate sub-projects, each with its own spec → plan → implementation cycle.

---

## Decisions (locked)

1. **Feature parity** with MySQL/PostgreSQL (introspection + query + inline edit + ER diagram + multi-statement).
2. **Write policy:** writes allowed by default (reusing the existing write-confirmation guard) **plus** a per-connection **read-only** checkbox. When read-only, the file is opened with `mode=ro` so writes are rejected by SQLite itself.
3. **Model mapping (Approach A):** reuse `domain.ConnectionProfile`. The file path is stored in the existing `Database` field; add one new field `ReadOnly bool`. No dedicated `FilePath`/DSN field.

---

## 1. Data model

`engine/internal/domain/connection.go`
- Add field `ReadOnly bool` with JSON tag `readOnly` to `ConnectionProfile`.
- For `Driver == "sqlite"`: `Database` holds the **absolute file path**; `Host`, `Port`, `Username`, `SecretRef`, `TLSMode` are unused.
- `Validate()`: add a `sqlite` branch.
  - Accept `"sqlite"` as a valid driver (currently the driver allow-list rejects it).
  - Require `Database` (the file path) to be non-empty.
  - Do **not** require `Host`; do **not** require `Port` in `1..65535` (the generic checks must be skipped for sqlite).
  - Keep the `Name` requirement.

`engine/internal/adapters/sqlite/sqlite_profile_repository.go` (the app's **internal** profile store — distinct from the new connectable-SQLite connector)
- Migration: add column `read_only INTEGER NOT NULL DEFAULT 0` to the profiles table.
- Read/write `ReadOnly` in the row mapping (INTEGER 0/1 ↔ bool).
- Existing rows default to `0` (writable), preserving current behavior.

## 2. Engine connector

New file `engine/internal/adapters/sqlite/sqlite_connector.go` — a connectable-database adapter, separate from the existing internal workspace/profile repositories in the same package.

- Type `SQLiteConnector struct{ ... }` implementing **all** `ports.SQLConnector` methods.
- Driver library: `modernc.org/sqlite` (already a dependency — promote from indirect to direct in `go.mod`). Pure Go, no cgo, so packaging is unaffected.
- A process-wide in-memory **session registry** (`map[int64]context.CancelFunc` guarded by a mutex, plus a monotonic counter seeded from a field) to support cancellation, since SQLite has no server-side `KILL`.

**DSN / open:**
- Build `file:<abs-path>?_pragma=busy_timeout(5000)`.
- Read-only connection (`profile.ReadOnly == true`): append `&mode=ro`.
- Helper `open(p, readOnly)` returns `*sql.DB` via `sql.Open("sqlite", dsn)`.

**Methods:**
- `TestConnection`: open and run `SELECT count(*) FROM sqlite_master` (verifies the file is a real SQLite database; a non-DB file fails with a clear error).
- `ListDatabases`: return a single `DatabaseInfo{Name: filepath.Base(path)}` — the file's logical database.
- `ListTables(database)`: `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`.
- `ListViews(database)`: same with `type='view'`.
- `GetTableDDL` / `GetViewDDL`: `SELECT sql FROM sqlite_master WHERE type=? AND name=?`.
- `DescribeTable(table)`: `PRAGMA table_info(<ident>)` → `ColumnInfo{Name, Type, Nullable=!notnull, PrimaryKey=pk>0}`.
- `ListColumns(database)`: enumerate tables, then `PRAGMA table_info` per table (or `pragma_table_info` join) to build the flat `[]ColumnRef{Table, Column, Type}` used for editor autocomplete.
- `ListForeignKeys(table)`: `PRAGMA foreign_key_list(<ident>)` → `ForeignKey{Column=from, RefTable=table, RefColumn=to}`.
- `ListIndexes(table)`: `PRAGMA index_list(<ident>)` for each index (name, unique, origin→primary when `origin='pk'`), then `PRAGMA index_info(<index>)` for ordered columns.
- `GetSchemaGraph(database)`: combine all tables (with columns) and all foreign keys into a `SchemaGraph`.
- `ExecuteQueryStream(...)`: open the DB (honoring read-only), derive a child `context` + `CancelFunc`, register it under a new session id, call `onSessionStart(id)`, run the query, stream `onHeader(columns)` then `onRow(values)` for each row; deregister on return. Returns the affected-row count for non-`SELECT` statements.
- `ExecuteBatch(statements)`: `BEGIN` (via `sql.Tx`), execute statements in order, `ROLLBACK` on the first error returning `failedIndex`, else `COMMIT`. Same contract as MySQL/PostgreSQL (atomic).
- `CancelSession(sessionID)`: look up the registry and invoke the stored `CancelFunc`; missing id is a no-op (already finished).
- `normalizeError(err)`: friendly messages for: file not found, "file is not a database", "attempt to write a readonly database", and "database is locked" (busy_timeout mitigates the last).

**Identifier escaping:** quote SQLite identifiers by wrapping in double quotes and doubling embedded quotes (`"` → `""`) for all PRAGMA/DDL interpolation, mirroring the existing `escapeMySQLIdent` pattern.

## 3. Driver registration

- `engine/internal/transport/http/query.go` and `introspection.go`: add a `sqliteConnector *sqlite.SQLiteConnector` field, construct it in the `New*Handler`, and add `case "sqlite": return h.sqliteConnector, nil` to `getConnector`.
- `engine/cmd/app-engine/main.go` (MCP connector selection): add `case "sqlite": conn = sqlite.NewSQLiteConnector()`.
- `engine/internal/agent/tools.go`: if it selects a connector or branches on driver, add the `sqlite` case so the agent can introspect/query SQLite too.

## 4. Renderer

- `apps/renderer/src/global.d.ts`: extend `ConnectionProfile.driver` to `'mysql' | 'postgres' | 'redis' | 'sqlite'`; add `readOnly?: boolean`.
- Connection form (`App.tsx`): when `driver === 'sqlite'`, render only:
  - **File path** text input (read-only display) + **찾아보기** (Browse) button that calls the new `pickSqliteFile` IPC and sets `database` to the chosen absolute path.
  - **읽기 전용** (read-only) checkbox bound to `readOnly`.
  - Hide host, port, username, password, and TLS fields. Skip the port default for sqlite.
- Driver picker: add a **SQLite** option with an "SQ" badge/icon consistent with the existing MY/PG badges.
- Schema tree, query editor, result grid, inline editing, ER diagram: **unchanged** — they operate through the driver-agnostic engine endpoints. One database node (the file basename) → tables/views/indexes.
- Test-connection and connect flows: unchanged.

## 5. IPC — native file picker

- `apps/desktop/src/main/index.ts`: add a `pickSqliteFile` IPC handler using `dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'SQLite', extensions: ['db','sqlite','sqlite3','db3'] }, { name: 'All Files', extensions: ['*'] }] })`. Return the selected absolute path or `null` if cancelled.
- `apps/desktop/src/preload/index.ts`: expose `pickSqliteFile: () => Promise<string | null>`.
- `apps/renderer/src/global.d.ts`: add the `pickSqliteFile` signature to the `electronAPI` interface.

## 6. Error handling

Engine `normalizeError` maps low-level driver errors to friendly text (file missing, not a SQLite database, read-only write attempt, locked). These surface through the existing error plumbing (HTTP error body → renderer toast/result error), so no renderer-side changes beyond what already handles MySQL/PostgreSQL errors.

## 7. Testing

**Engine (TDD, hermetic — no external server):** `engine/internal/adapters/sqlite/sqlite_connector_test.go`
- Helper creates a temp `.db` via `modernc.org/sqlite` and seeds: two tables with a foreign key, a view, a unique index, a multi-column index, and sample rows.
- Assert each `SQLConnector` method: `ListDatabases`, `ListTables`, `ListViews`, `GetTableDDL`, `GetViewDDL`, `DescribeTable`, `ListColumns`, `ListForeignKeys`, `ListIndexes`, `GetSchemaGraph`.
- `ExecuteQueryStream`: SELECT streams the expected header + rows; a write statement on a writable connection succeeds and returns the affected count.
- Read-only mode: a write statement is rejected with the normalized read-only error.
- `ExecuteBatch`: a failing statement mid-batch rolls back all prior statements (atomic) and reports the correct `failedIndex`.
- `CancelSession`: cancelling a registered session aborts an in-flight query (use a slow/recursive CTE or a `busy` loop) — context cancellation returns promptly.
- `normalizeError`: missing file and non-DB file produce the friendly messages.

**Domain:** `connection_test.go` — `Validate()` accepts a sqlite profile with a file path and no host/port, and rejects a sqlite profile with an empty `Database`.

**Profile repository:** a test asserts the `read_only` column round-trips (true/false) and that the migration is idempotent / defaults existing rows to writable.

**Renderer:** a component/unit test (where feasible with the existing harness) that the connection form renders the file-path + read-only fields for `driver='sqlite'` and hides host/port.

**Live CDP verification:** create a temp SQLite file with seeded data, launch the dev app, add a SQLite connection via the file picker, connect, browse the schema tree, run a read query, open the ER diagram, toggle read-only and confirm a write is blocked, then on a writable connection do an allowed write + one inline cell edit. Capture a screenshot.

## 8. Scope boundaries (YAGNI)

- **Open existing files only.** No "create new SQLite database" in this sub-project (can be added later).
- **Single logical database per file.** No `ATTACH`-based multi-database browsing yet.
- SQL Server and MongoDB are **out of scope** here — separate sub-projects.

## File structure (new/modified)

**New**
- `engine/internal/adapters/sqlite/sqlite_connector.go` — the connectable-SQLite `SQLConnector` implementation.
- `engine/internal/adapters/sqlite/sqlite_connector_test.go` — hermetic tests.

**Modified — engine**
- `engine/internal/domain/connection.go` — `ReadOnly` field + `Validate()` sqlite branch.
- `engine/internal/adapters/sqlite/sqlite_profile_repository.go` (+ migration) — `read_only` column.
- `engine/internal/transport/http/query.go`, `introspection.go` — register sqlite connector.
- `engine/cmd/app-engine/main.go` — MCP connector case.
- `engine/internal/agent/tools.go` — sqlite case (if driver-branched).
- `go.mod` — promote `modernc.org/sqlite` to a direct dependency.

**Modified — desktop/renderer**
- `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts` — `pickSqliteFile` IPC.
- `apps/renderer/src/global.d.ts` — driver union, `readOnly`, `pickSqliteFile`.
- `apps/renderer/src/App.tsx` (+ CSS) — sqlite connection form branch + driver picker option.
