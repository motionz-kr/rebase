# SQL Server Connector — Design

**Milestone:** #5 Database engine expansion (Epic #34) — second sub-project (after SQLite).
**Goal:** Make Microsoft SQL Server a fully connectable database with feature parity to the existing MySQL/PostgreSQL/SQLite engines: connect, browse schema (tables/views/indexes/foreign keys), run read & write queries, paginated table data view, inline-edit, view/reconstruct DDL, the ER diagram, multi-statement batches, and the schema-DDL editing dialogs.

**Scope:** SQL Server only, **SQL authentication** (username/password). Windows / Azure AD authentication is out of scope (deferred). MongoDB is a separate sub-project.

---

## Decisions (locked)

1. **Full parity** with the other engines, including full **DDL reconstruction** for "view table DDL" (SQL Server has no `SHOW CREATE TABLE`; rebuild from `sys` catalog).
2. **Driver:** `github.com/microsoft/go-mssqldb` (official, maintained, pure Go). `sql.Open("sqlserver", dsn)`.
3. **Model:** reuse `domain.ConnectionProfile` unchanged — SQL Server is host:port like MySQL/PostgreSQL. No new fields. Default port 1433.
4. **Auth:** SQL auth only. `TLSMode` (none/prefer/require) maps to the driver's `encrypt` parameter.
5. **Testing:** live integration tests against a Docker SQL Server (`mcr.microsoft.com/mssql/server:2022-latest`), gated like the existing MySQL/PostgreSQL integration tests (skip when no server). Renderer unit tests for the T-SQL builder branches. CDP live verification against the Docker server.

---

## 1. Data model

`engine/internal/domain/connection.go`
- `Validate()`: add `"sqlserver"` to the driver allow-list. Same requirements as mysql/postgres: Host required, Port in 1..65535, Database required.
- No new struct fields. `Username`/`SecretRef`(password)/`Host`/`Port`/`Database`/`TLSMode` are used exactly as for mysql/postgres.

No profile-repository migration is needed (no new columns).

## 2. Engine connector

New file `engine/internal/adapters/sqlserver/sqlserver_connector.go` — implements `ports.SQLConnector` via `github.com/microsoft/go-mssqldb`.

- **DSN / connect:** build a `sqlserver://` URL: `sqlserver://<user>:<pass>@<host>:<port>?database=<db>&encrypt=<mode>&connection+timeout=5`.
  - `encrypt`: `TLSMode == "require"` → `encrypt=true&trustServerCertificate=true`; `"prefer"` → `encrypt=true&trustServerCertificate=true` (opportunistic, cert not verified); `"none"`/default → `encrypt=disable`. (Certificate verification with a configurable CA bundle is the same deferred "advanced certificate profile" as the other engines — use `trustServerCertificate=true` to allow encryption without a CA bundle.)
  - URL-encode username/password (they may contain special chars).
- **Identifier quoting:** `[name]`, escaping `]` → `]]`.
- **Introspection (catalog queries):**
  - `ListDatabases`: `SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name` (excludes the four system DBs master/tempdb/model/msdb; the connected database may itself be a user DB).
  - `ListTables(db)`: connect to `db`; `SELECT s.name + '.' ... ` — return base tables as `schema.table` is overkill; SQL Server tables live under schemas (default `dbo`). Return `TABLE_NAME` from `INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE'` for the connected database, qualified by schema only when not `dbo` (keep `dbo.` implicit for the common case, mirroring how the UI shows bare names). **Decision:** return bare `TABLE_NAME` ordered by name; identifiers are resolved against the default schema. (Schema-qualified browsing is a later enhancement.)
  - `ListViews(db)`: `INFORMATION_SCHEMA.VIEWS`.
  - `DescribeTable(db, table)`: `INFORMATION_SCHEMA.COLUMNS` (name, data_type, is_nullable) joined with PK info from `INFORMATION_SCHEMA.KEY_COLUMN_USAGE`/`TABLE_CONSTRAINTS` (constraint_type='PRIMARY KEY').
  - `ListColumns(db)`: all columns across tables via `INFORMATION_SCHEMA.COLUMNS` → `[]ColumnRef`.
  - `ListForeignKeys(db, table)`: `sys.foreign_keys` + `sys.foreign_key_columns` joined to `sys.tables`/`sys.columns`, or `INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS` + `KEY_COLUMN_USAGE`.
  - `ListIndexes(db, table)`: `sys.indexes` + `sys.index_columns` + `sys.columns` (exclude heaps `type=0`; report `is_unique`, `is_primary_key`).
  - `GetSchemaGraph(db)`: all tables+columns + all FKs in two catalog queries.
  - `GetViewDDL(db, view)`: `OBJECT_DEFINITION(OBJECT_ID(@view))` or `sys.sql_modules.definition` — SQL Server stores view definitions.
  - `GetTableDDL(db, table)`: **reconstruct** `CREATE TABLE` from `sys`/`INFORMATION_SCHEMA`: columns with full type (including length/precision/scale), nullability, `IDENTITY(seed,increment)` where `is_identity=1`, `DEFAULT` constraints, and a table-level `PRIMARY KEY (...)`. A pure helper assembles the statement from a struct list so it is unit-testable.
- **ExecuteQueryStream:** open a `*sql.Conn`; capture `@@SPID` (`SELECT @@SPID`) for cancellation; honor `readOnly` (defense-in-depth: `SET TRANSACTION ISOLATION LEVEL ...` is not a write-block — instead rely on the app policy gate; optionally `SET` nothing and let the policy gate enforce, matching the existing mysql behavior which also uses `SET SESSION TRANSACTION READ ONLY` — SQL Server has no exact equivalent, so the read-only guard is the application policy layer only for sqlserver). Stream header + rows; convert driver types (`[]byte`→string, etc.).
- **ExecuteBatch:** single transaction; rollback on first failure returning `failedIndex`; commit otherwise.
- **CancelSession(spid):** open a new connection and run `KILL <spid>`.
- **normalizeError:** map common errors (login failed (18456), cannot open database (4060), network/timeout, TLS) to the shared `adapters.Err*` sentinels + friendly text.

## 3. Driver registration

- `query.go`, `introspection.go`, `agent.go` `getConnector` switches + `profile.go` `TestConnection` switch + `cmd/app-engine/main.go` `runMCPServer` switch — add a `sqlserver` case constructing `sqlserver.NewSQLServerConnector()`.
- `engine/internal/domain/connection.go` `Validate()` — accept `sqlserver`.
- `go.mod` — add `github.com/microsoft/go-mssqldb`.
- `engine/internal/agent/tools.go` — `quoteIdent` sqlserver → `[brackets]`; `table_stats` sqlserver branch (`sys.dm_db_partition_stats` row count + `sp_spaceused`-style bytes, or a simple `SELECT COUNT(*)` + 0 bytes if the DMV is unavailable).

## 4. Renderer

- `global.d.ts` + `App.tsx` local interface: `driver` union gains `'sqlserver'`.
- Connection form: add a **SQL Server** driver option; `handleDriverChange('sqlserver')` sets port **1433**, username `sa`, a sensible default database (`master`). Host/port/username/password/TLS fields render exactly as for mysql/postgres (no sqlite-style file picker). `DRIVER_LABEL` gains `sqlserver: 'MS'`.
- **T-SQL dialect branches** in the renderer libs (driver type `Driver` gains `'sqlserver'`):
  - `ddlBuilder.quoteIdent`: sqlserver → `[name]` (escape `]`→`]]`).
  - `ddlBuilder.buildCreateTable`: auto-increment → `IDENTITY(1,1)`; table-level `PRIMARY KEY (...)`.
  - `ddlBuilder.buildTruncateTable`: `TRUNCATE TABLE` (SQL Server supports it).
  - `ddlBuilder.buildModifyColumn`: SQL Server `ALTER TABLE ... ALTER COLUMN <col> <type> [NULL|NOT NULL]` (one statement; defaults are separate `ADD/DROP CONSTRAINT` — for parity scope, support type + nullability changes via `ALTER COLUMN`; default changes are best-effort `ADD DEFAULT`).
  - `dmlBuilder.sqlLiteral`: bracket quoting via quoteIdent; booleans → `1`/`0` (the `bit` type); standard `'`→`''` escaping (no backslash).
  - `tableQuery.buildSelectPage` (pagination): sqlserver → `OFFSET <offset> ROWS FETCH NEXT <limit> ROWS ONLY`, which **requires** an `ORDER BY`. When the caller has no explicit order, append `ORDER BY (SELECT NULL)` (a valid no-op ordering SQL Server accepts with OFFSET).
  - `recentQuery.buildRecentRowsQuery`: sqlserver → `SELECT TOP <limit> * FROM <t> [ORDER BY <pk> DESC]`.
- `SchemaExplorer`/`App.tsx`/`TableDataView`: widen the `driver` casts to include `'sqlserver'` (now part of `Driver`). All DDL dialogs work for sqlserver (no per-driver hiding — unlike sqlite, SQL Server supports CREATE/ALTER/TRUNCATE/MODIFY COLUMN).

## 5. Error handling

`normalizeError` maps SQL Server errors to friendly text and the shared sentinels; surfaced through the existing error plumbing. No renderer changes beyond what already handles mysql/postgres errors.

## 6. Testing

**Engine integration tests** (`engine/internal/adapters/sqlserver/sqlserver_integration_test.go`): gated on a `SQLSERVER_TEST_DSN` env var (or the conventional host/credentials the other integration tests use) — skip when absent, like the mysql/postgres integration tests. Against a live Docker SQL Server, seed a schema and assert every `SQLConnector` method (introspection, query stream, batch atomic rollback, cancel, DDL reconstruction).

**Engine pure-unit test** for the DDL-reconstruction assembler (the pure function that builds `CREATE TABLE` text from a column/constraint struct list) — hermetic, no server.

**Renderer unit tests**: extend `ddlBuilder.test.ts`, `dmlBuilder.test.ts`, `tableQuery.test.ts`, `recentQuery.test.ts` with sqlserver cases (bracket quoting, IDENTITY, TRUNCATE, OFFSET/FETCH, TOP).

**Live CDP verification**: against the Docker SQL Server — add a connection, connect, browse schema (tables/views/indexes/FK), run a SELECT, page through table data, inline-edit a row, view reconstructed DDL, open the ER diagram, create/alter/truncate a table via the dialogs. Screenshot.

## 7. Scope boundaries (YAGNI)

- **SQL authentication only** (Windows/Azure AD deferred).
- **Default-schema browsing** — tables/views shown by bare name (resolved against the default schema, typically `dbo`); multi-schema qualification is a later enhancement.
- MongoDB is a separate sub-project.

## File structure (new/modified)

**New**
- `engine/internal/adapters/sqlserver/sqlserver_connector.go` — the `SQLConnector` implementation.
- `engine/internal/adapters/sqlserver/sqlserver_ddl.go` — pure DDL-reconstruction assembler (so it is unit-testable without a server).
- `engine/internal/adapters/sqlserver/sqlserver_ddl_test.go` — hermetic unit tests for the assembler.
- `engine/internal/adapters/sqlserver/sqlserver_integration_test.go` — live integration tests (skipped without a server).

**Modified — engine**
- `engine/internal/domain/connection.go` (+ test) — `sqlserver` in `Validate()`.
- `engine/internal/transport/http/query.go`, `introspection.go`, `agent.go`, `profile.go` — register the connector.
- `engine/cmd/app-engine/main.go` — MCP connector case.
- `engine/internal/agent/tools.go` — `quoteIdent` + `table_stats` sqlserver branches.
- `go.mod` / `go.sum` — add the driver.

**Modified — renderer**
- `apps/renderer/src/global.d.ts`, `apps/renderer/src/App.tsx` (+ `App.css` if needed) — driver union + form option.
- `apps/renderer/src/lib/ddlBuilder.ts` (+ test), `dmlBuilder.ts` (+ test), `tableQuery.ts` (+ test), `recentQuery.ts` (+ test) — T-SQL dialect.
- `apps/renderer/src/components/SchemaExplorer.tsx`, `TableDataView.tsx`, `QueryEditor.tsx` — driver-union widenings + a sqlserver starter query.
