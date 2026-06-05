# SQL Server Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add Microsoft SQL Server as a fully connectable database with feature parity to the existing MySQL/PostgreSQL/SQLite engines.

**Architecture:** A new `SQLServerConnector` in `engine/internal/adapters/sqlserver/` implements `ports.SQLConnector` using `github.com/microsoft/go-mssqldb`. SQL Server is host:port + SQL auth (reuse `ConnectionProfile` unchanged). Introspection uses the `sys`/`INFORMATION_SCHEMA` catalog; `GetTableDDL` reconstructs `CREATE TABLE` from a pure, unit-tested assembler. Cancellation uses `KILL @@SPID`. The renderer's pure SQL builders gain a T-SQL (`sqlserver`) dialect (bracket quoting, IDENTITY, TRUNCATE, OFFSET/FETCH pagination, TOP).

**Tech Stack:** Go 1.25 (`/Users/smlee/sdk/go/bin/go`), `github.com/microsoft/go-mssqldb`, React 19 + Vite, Electron 28, Docker (`mcr.microsoft.com/mssql/server:2022-latest`) for integration tests.

**Conventions:** Branch `feat/sqlserver-connector` (already created). Conventional Commits; end commit bodies with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Engine tests: `/Users/smlee/sdk/go/bin/go test ./...` from `engine/`.

**Live test server (for integration tasks):** a Docker SQL Server reachable at `localhost:1433`, SA login. Start it with:
```bash
docker run -d --name rebase-mssql -e ACCEPT_EULA=Y -e 'MSSQL_SA_PASSWORD=Strong!Passw0rd' -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest
```
Integration tests read DSN from env `SQLSERVER_TEST_DSN` (e.g. `sqlserver://sa:Strong!Passw0rd@localhost:1433?database=master&encrypt=disable`) and **skip** when it is unset, mirroring the mysql/postgres integration tests.

---

## Phase S-E: Engine

### Task S-E1: Domain — accept the `sqlserver` driver

**Files:** Modify `engine/internal/domain/connection.go`; Test `engine/internal/domain/connection_test.go`.

- [ ] **Step 1: Failing test** — append:
```go
func TestValidate_SQLServerAcceptedLikeRelational(t *testing.T) {
	p := ConnectionProfile{Name: "ms", Driver: "sqlserver", Host: "h", Port: 1433, Database: "db", Username: "sa"}
	if err := p.Validate(); err != nil {
		t.Fatalf("expected sqlserver profile to be valid, got: %v", err)
	}
}
func TestValidate_SQLServerRequiresHostPortDatabase(t *testing.T) {
	if (ConnectionProfile{Name: "x", Driver: "sqlserver", Host: "", Port: 1433, Database: "db"}).Validate() == nil {
		t.Fatal("expected missing host to be invalid")
	}
	if (ConnectionProfile{Name: "x", Driver: "sqlserver", Host: "h", Port: 1433, Database: ""}).Validate() == nil {
		t.Fatal("expected missing database to be invalid")
	}
}
```
- [ ] **Step 2:** Run `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/domain/ -run TestValidate_SQLServer -v` → FAIL (`unsupported database driver: sqlserver`).
- [ ] **Step 3:** In `Validate()`, add `sqlserver` to the driver allow-list and to the relational `Database`-required check:
  - Change `p.Driver != "mysql" && p.Driver != "postgres" && p.Driver != "redis" && p.Driver != "sqlite"` to also allow `&& p.Driver != "sqlserver"`.
  - Change the relational database-required line `if (p.Driver == "mysql" || p.Driver == "postgres") && p.Database == ""` to also include `|| p.Driver == "sqlserver"`.
  (SQL Server uses the same Host/Port checks as mysql/postgres — no early return like sqlite.)
- [ ] **Step 4:** Run the test → PASS. Run full `./internal/domain/`.
- [ ] **Step 5: Commit** `feat(engine): accept sqlserver driver in profile validation`.

### Task S-E2: go.mod driver + pure DDL-reconstruction assembler

**Files:** Modify `go.mod`; Create `engine/internal/adapters/sqlserver/sqlserver_ddl.go`, `engine/internal/adapters/sqlserver/sqlserver_ddl_test.go`.

The assembler builds a `CREATE TABLE` string from a struct list, so DDL reconstruction is testable without a server.

- [ ] **Step 1: Add the driver** — `cd engine && /Users/smlee/sdk/go/bin/go get github.com/microsoft/go-mssqldb@latest` then `go mod tidy`. (Repo-root `go.mod`.)
- [ ] **Step 2: Failing test** — create `sqlserver_ddl_test.go`:
```go
package sqlserver

import "testing"

func TestBuildCreateTableDDL(t *testing.T) {
	cols := []DDLColumn{
		{Name: "id", Type: "int", Nullable: false, Identity: true, IdentitySeed: 1, IdentityIncr: 1},
		{Name: "title", Type: "nvarchar(255)", Nullable: false},
		{Name: "note", Type: "nvarchar(max)", Nullable: true, Default: "('')"},
	}
	got := BuildCreateTableDDL("dbo", "todos", cols, []string{"id"})
	want := "CREATE TABLE [dbo].[todos] (\n" +
		"  [id] int IDENTITY(1,1) NOT NULL,\n" +
		"  [title] nvarchar(255) NOT NULL,\n" +
		"  [note] nvarchar(max) NULL DEFAULT ('') ,\n" +
		"  CONSTRAINT [PK_todos] PRIMARY KEY ([id])\n" +
		")"
	if got != want {
		t.Fatalf("DDL mismatch:\n got=%q\nwant=%q", got, want)
	}
}
func TestBuildCreateTableDDL_NoPK(t *testing.T) {
	got := BuildCreateTableDDL("dbo", "t", []DDLColumn{{Name: "a", Type: "int", Nullable: true}}, nil)
	if got != "CREATE TABLE [dbo].[t] (\n  [a] int NULL\n)" {
		t.Fatalf("got=%q", got)
	}
}
```
- [ ] **Step 3:** Run `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/adapters/sqlserver/ -run TestBuildCreateTableDDL -v` → FAIL (undefined).
- [ ] **Step 4: Implement** `sqlserver_ddl.go`:
```go
package sqlserver

import "strings"

// DDLColumn is one column for CREATE TABLE reconstruction.
type DDLColumn struct {
	Name         string
	Type         string // full type incl. length/precision, e.g. "nvarchar(255)"
	Nullable     bool
	Identity     bool
	IdentitySeed int64
	IdentityIncr int64
	Default      string // raw default expression incl. parens, e.g. "('')"; empty for none
}

func quoteIdent(name string) string {
	return "[" + strings.ReplaceAll(name, "]", "]]") + "]"
}

// BuildCreateTableDDL reconstructs a CREATE TABLE statement. Pure + unit-tested.
func BuildCreateTableDDL(schema, table string, cols []DDLColumn, pk []string) string {
	lines := make([]string, 0, len(cols)+1)
	for _, c := range cols {
		s := "  " + quoteIdent(c.Name) + " " + c.Type
		if c.Identity {
			s += " IDENTITY(" + itoa(c.IdentitySeed) + "," + itoa(c.IdentityIncr) + ")"
		}
		if c.Nullable {
			s += " NULL"
		} else {
			s += " NOT NULL"
		}
		if strings.TrimSpace(c.Default) != "" {
			s += " DEFAULT " + c.Default + " "
		}
		lines = append(lines, s)
	}
	if len(pk) > 0 {
		qpk := make([]string, len(pk))
		for i, c := range pk {
			qpk[i] = quoteIdent(c)
		}
		lines = append(lines, "  CONSTRAINT "+quoteIdent("PK_"+table)+" PRIMARY KEY ("+strings.Join(qpk, ", ")+")")
	}
	return "CREATE TABLE " + quoteIdent(schema) + "." + quoteIdent(table) + " (\n" + strings.Join(lines, ",\n") + "\n)"
}

func itoa(n int64) string {
	// small local helper to avoid importing strconv at call sites
	return strings.TrimSpace(strings.Replace(fmtInt(n), " ", "", -1))
}
```
> NOTE to implementer: use `strconv.FormatInt(n, 10)` instead of the `itoa`/`fmtInt` placeholder above — import `strconv` and replace `itoa(c.IdentitySeed)` with `strconv.FormatInt(c.IdentitySeed, 10)`. The test's exact expected string is the contract; adjust spacing to match it precisely (note the trailing space after the DEFAULT expression in the first test, and that a column with a default still works). If matching the exact default spacing is awkward, change BOTH the implementation and the test together so they agree and the DDL is valid T-SQL — the test is the spec, keep it asserting real, valid output.
- [ ] **Step 5:** Run the test → PASS. `gofmt -w`, `go vet`, `go build ./...`.
- [ ] **Step 6: Commit** `feat(engine): sqlserver DDL reconstruction assembler + add mssql driver`.

### Task S-E3a: Connector — connect + tables/views/DDL(view) introspection

**Files:** Create `engine/internal/adapters/sqlserver/sqlserver_connector.go`, `engine/internal/adapters/sqlserver/sqlserver_integration_test.go`.

These are **integration** tests (need the live Docker server). They must SKIP when `SQLSERVER_TEST_DSN` is unset.

- [ ] **Step 1:** Ensure the Docker server is running (see plan header). Export `SQLSERVER_TEST_DSN="sqlserver://sa:Strong!Passw0rd@localhost:1433?database=master&encrypt=disable"`.
- [ ] **Step 2: Failing integration test** — create `sqlserver_integration_test.go` with a skip guard + a seed helper that creates a temp database and schema, then tests `TestConnection`, `ListDatabases`, `ListTables`, `ListViews`, `GetViewDDL`:
```go
package sqlserver

import (
	"context"
	"database/sql"
	"os"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	_ "github.com/microsoft/go-mssqldb"
)

func testProfile(t *testing.T, database string) (domain.ConnectionProfile, string) {
	dsn := os.Getenv("SQLSERVER_TEST_DSN")
	if dsn == "" {
		t.Skip("SQLSERVER_TEST_DSN not set; skipping SQL Server integration test")
	}
	// parse host/port/user/pass out of the DSN for the profile; password returned separately.
	// (implementer: parse with net/url; the profile.Database overrides the DSN database.)
	...
}
```
> The implementer writes a seed helper that connects to `master`, `CREATE DATABASE rebase_test_<rand>` (use a fixed name like `rebase_test` and DROP/CREATE for idempotency), then creates: `authors(id int identity primary key, name nvarchar(100) not null)`, `books(id int identity primary key, title nvarchar(200) not null, author_id int references authors(id))`, a view `book_titles`, a unique index, and seed rows. Tests assert ListTables = [authors, books] (ordered), ListViews = [book_titles], GetViewDDL non-empty, TestConnection ok, ListDatabases includes `rebase_test`.
- [ ] **Step 3:** Run `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/adapters/sqlserver/ -run TestSQLServer -v` → FAIL (undefined connector).
- [ ] **Step 4: Implement** the connector struct + these methods in `sqlserver_connector.go`:
  - `type SQLServerConnector struct{}` + `NewSQLServerConnector()`.
  - `dsn(p, password, database)` building `sqlserver://user:pass@host:port?database=<database>&encrypt=<...>&connection+timeout=5` (URL-encode user/pass via `net/url`; map TLSMode→encrypt: require/prefer→`encrypt=true&trustServerCertificate=true`, else `encrypt=disable`).
  - `connect(p, password, database) (*sql.DB, error)` → `sql.Open("sqlserver", dsn)`.
  - `TestConnection` → `db.PingContext`.
  - `ListDatabases` → `SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name`.
  - `ListTables(database)` → connect to `database`; `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME`.
  - `ListViews(database)` → `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.VIEWS ORDER BY TABLE_NAME`.
  - `GetTableDDL` → leave a stub returning `("", nil)` for now? NO — it's needed in S-E3b; for S-E3a, implement only `GetViewDDL` and the methods listed. To keep the package compiling WITHOUT the full interface assertion yet, do NOT add `var _ ports.SQLConnector` until S-E3c.
  - `GetViewDDL(database, view)` → `SELECT m.definition FROM sys.sql_modules m JOIN sys.objects o ON o.object_id=m.object_id WHERE o.name=@p1` (bind `view`).
  - `normalizeError(err)` → friendly messages for login failed (contains "Login failed"), cannot open database (contains "Cannot open database"), and a default passthrough.
  - Identifier quoting helper reusing `quoteIdent` from sqlserver_ddl.go.
  > go-mssqldb parameter binding: use positional `@p1`, `@p2` placeholders with `db.QueryContext(ctx, q, val)`, or `sql.Named`. Use whichever the implementer confirms works against the live server (the tests are the arbiter).
- [ ] **Step 5:** Run the integration test → PASS (with the server up).
- [ ] **Step 6:** `gofmt`, `go vet`, `go build ./...`.
- [ ] **Step 7: Commit** `feat(engine): sqlserver connector — connect + tables/views/view DDL`.

### Task S-E3b: Connector — columns, FKs, indexes, schema graph, table DDL

**Files:** Modify `sqlserver_connector.go`, `sqlserver_integration_test.go`.

- [ ] **Step 1: Failing integration tests** for `DescribeTable`, `ListColumns`, `ListForeignKeys`, `ListIndexes`, `GetSchemaGraph`, `GetTableDDL` (assert against the seeded schema: books has 3 columns with `id` PK + identity, FK author_id→authors.id, the unique index, schema graph 2 tables/1 FK, and `GetTableDDL("...","books")` contains `CREATE TABLE`, `[books]`, `IDENTITY`, `PRIMARY KEY`).
- [ ] **Step 2:** Run → FAIL (undefined methods).
- [ ] **Step 3: Implement** using the catalog queries (bind table name as a parameter):
  - `DescribeTable` — columns + PK flag:
    ```sql
    SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE,
      CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END
    FROM INFORMATION_SCHEMA.COLUMNS c
    LEFT JOIN (
      SELECT ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME=ku.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_TYPE='PRIMARY KEY' AND tc.TABLE_NAME=@p1
    ) pk ON pk.COLUMN_NAME=c.COLUMN_NAME
    WHERE c.TABLE_NAME=@p1 ORDER BY c.ORDINAL_POSITION
    ```
    Map `IS_NULLABLE='YES'`→Nullable.
  - `ListColumns(database)` — all base-table columns as `ColumnRef{Table, Column, Type}` via `INFORMATION_SCHEMA.COLUMNS` joined to `INFORMATION_SCHEMA.TABLES` (BASE TABLE), ordered by table, ordinal.
  - `ListForeignKeys(table)` — `sys.foreign_keys`/`sys.foreign_key_columns` join (see spec §2) returning `{Column, RefTable, RefColumn}`.
  - `ListIndexes(table)` — `sys.indexes`+`sys.index_columns`+`sys.columns` (type<>0), grouping rows by index name into `{Name, Columns[], Unique, Primary}`.
  - `GetSchemaGraph(database)` — all tables (with columns via INFORMATION_SCHEMA.COLUMNS) + all FKs (sys.foreign_keys across the db).
  - `GetTableDDL(database, table)` — query columns with FULL type assembly: `DATA_TYPE` + length/precision (`CHARACTER_MAXIMUM_LENGTH` → `(n)` or `(max)` when -1; `NUMERIC_PRECISION/SCALE` for decimal/numeric), `IS_NULLABLE`, `COLUMN_DEFAULT`, plus `sys.columns.is_identity`/`seed_value`/`increment_value` (via `IDENTITY_SEED`/`IDENTITY_INCR` from `sys.identity_columns`), and the PK column list; build `[]DDLColumn` and call `BuildCreateTableDDL("dbo", table, cols, pk)`.
- [ ] **Step 4:** Run → PASS. `gofmt`, `go vet`, `go build`.
- [ ] **Step 5: Commit** `feat(engine): sqlserver connector — columns, FKs, indexes, graph, table DDL`.

### Task S-E3c: Connector — query stream, batch, cancel, interface assertion

**Files:** Modify `sqlserver_connector.go`, `sqlserver_integration_test.go`.

- [ ] **Step 1: Failing integration tests** for `ExecuteQueryStream` (SELECT streams header+rows), `ExecuteBatch` (atomic rollback on a failing 2nd stmt + commit on success), and (best-effort) `CancelSession`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement:**
  - `ExecuteQueryStream(ctx, p, password, query, readOnly, onSessionStart, onHeader, onRow) (int64, error)`: open a `*sql.Conn`; `SELECT @@SPID` for the session id; `onSessionStart(spid)`; run `conn.QueryContext(ctx, query)`; stream `rows.Columns()` then scan each row (`[]byte`→string conversion like the mysql connector); return the row count. (No SQL Server session read-only mode exists; the app policy gate is the read-only guard. Do NOT attempt `SET TRANSACTION READ ONLY` — it is not valid T-SQL.)
  - `CancelSession(spid)`: open a fresh connection and `db.ExecContext(ctx, fmt.Sprintf("KILL %d", spid))`.
  - `ExecuteBatch(statements)`: `BeginTx`; exec each; rollback+`failedIndex` on first error; commit; accumulate RowsAffected.
  - Add `var _ ports.SQLConnector = (*SQLServerConnector)(nil)` (now the full interface must be satisfied — fix any signature mismatch against `engine/internal/ports/connector.go`).
  > CodeQL note: the `QueryContext(ctx, query)` and `ExecContext(ctx, stmt)` lines run operator-authored SQL by design (same as mysql/postgres/sqlite). Add a justification comment; the alerts (if any) are dismissed at PR time as won't-fix, consistent with the sqlite connector.
- [ ] **Step 4:** Run → PASS. `go build ./...` (interface satisfied).
- [ ] **Step 5: Commit** `feat(engine): sqlserver connector — query stream, batch, cancel`.

### Task S-E4: Register the connector + agent tools

**Files:** Modify `query.go`, `introspection.go`, `agent.go`, `profile.go`, `cmd/app-engine/main.go`, `engine/internal/agent/tools.go`.

- [ ] **Step 1:** In each of `query.go`/`introspection.go`/`agent.go`: add `import ".../adapters/sqlserver"`, a `sqlserverConnector *sqlserver.SQLServerConnector` field, construct it, and a `case "sqlserver": return h.sqlserverConnector, nil` in `getConnector`.
- [ ] **Step 2:** `profile.go` `TestConnection` switch: add `case "sqlserver": err = h.sqlserverConnector.TestConnection(...)` (+ field + import).
- [ ] **Step 3:** `cmd/app-engine/main.go` `runMCPServer`: add `case "sqlserver": conn = sqlserver.NewSQLServerConnector()` (+ import).
- [ ] **Step 4:** `engine/internal/agent/tools.go`: `quoteIdent` → `if driver == "sqlserver" { return "[" + strings.ReplaceAll(ident, "]", "]]") + "]" }` (add as its own branch, before the postgres/sqlite double-quote and mysql backtick branches); `table_stats` → add a `sqlserver` branch: `sql = "SELECT SUM(p.rows) AS rows, 0 AS bytes FROM sys.partitions p JOIN sys.tables t ON t.object_id=p.object_id WHERE t.name=" + lit + " AND p.index_id IN (0,1)"`.
- [ ] **Step 5:** `go build ./... && go test ./...` (integration tests skip without the env). Add a unit test for `quoteIdent("sqlserver", ...)` → brackets. Commit `feat(engine): register sqlserver connector + agent tools`.

## Phase S-R: Renderer

### Task S-R1: T-SQL dialect in the renderer builders (TDD)

**Files:** Modify `apps/renderer/src/lib/ddlBuilder.ts` (+test), `dmlBuilder.ts` (+test), `tableQuery.ts` (+test), `recentQuery.ts` (+test).

- [ ] **Step 1: Failing tests** — append sqlserver cases:
  - `ddlBuilder.test.ts`: `quoteIdent('sqlserver','a]b')` → `'[a]]b]'`; `buildCreateTable('sqlserver','t',[{id int PK AI},{name}])` contains `IDENTITY(1,1)` and `[id]` and a table-level `PRIMARY KEY`; `buildTruncateTable('sqlserver','t')` → `['TRUNCATE TABLE [t]']`; `buildModifyColumn('sqlserver','t',before,after)` for a type change → `['ALTER TABLE [t] ALTER COLUMN [c] <type> NOT NULL']`.
  - `dmlBuilder.test.ts`: `sqlLiteral('sqlserver', true)` → `'1'`; identifier quoting uses brackets.
  - `tableQuery.test.ts`: `buildSelectPage('sqlserver','t',{limit:10,offset:20,...})` ends with `OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY` and includes an `ORDER BY` (PK or `(SELECT NULL)`).
  - `recentQuery.test.ts`: `buildRecentRowsQuery('sqlserver','t','id',500)` → `SELECT TOP 500 * FROM [t] ORDER BY [id] DESC`; with null pk → `SELECT TOP 500 * FROM [t]`.
- [ ] **Step 2:** Run the four suites → FAIL.
- [ ] **Step 3: Implement** (the `Driver` type in `ddlBuilder.ts` already includes mysql/postgres/sqlite — add `'sqlserver'`):
  - `quoteIdent`: add `if (driver === 'sqlserver') return '[' + name.replace(/]/g, ']]') + ']';` (before the postgres/sqlite branch).
  - `buildCreateTable`: sqlserver branch — autoincrement → `IDENTITY(1,1)`; otherwise the shared logic with bracket quoting; table-level `PRIMARY KEY (...)`.
  - `buildTruncateTable`: sqlserver → `TRUNCATE TABLE` (it IS supported) — i.e. sqlserver uses the same `TRUNCATE TABLE` path as mysql/postgres (only sqlite differs with DELETE).
  - `buildModifyColumn`: sqlserver → `['ALTER TABLE <t> ALTER COLUMN <c> ' + type + (nullable?' NULL':' NOT NULL')]` for type/nullability; default changes (best-effort) → `ALTER TABLE <t> ADD DEFAULT <def> FOR <c>` appended when the default changed.
  - `dmlBuilder.sqlLiteral`: booleans → `1`/`0` for sqlserver too (extend the `mysql || sqlite` check to include `sqlserver`); quoting via the shared `quoteIdent`.
  - `tableQuery.buildSelectPage`: sqlserver → replace `LIMIT/OFFSET` with `... ORDER BY <existing order or (SELECT NULL)> OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`. Ensure an ORDER BY is always present for sqlserver (use the query's order-by if present, else `(SELECT NULL)`).
  - `recentQuery.buildRecentRowsQuery`: sqlserver → `SELECT TOP ${limit} * FROM <t> [ORDER BY <pk> DESC]` (no LIMIT).
- [ ] **Step 4:** Run the four suites → PASS. `tsc --noEmit`, `eslint`, full `vitest run`.
- [ ] **Step 5: Commit** `feat(renderer): T-SQL dialect in sql builders (sqlserver)`.

### Task S-R2: Connection form + component widenings

**Files:** Modify `apps/renderer/src/global.d.ts`, `App.tsx`, `components/SchemaExplorer.tsx`, `components/TableDataView.tsx`, `components/QueryEditor.tsx`.

- [ ] **Step 1:** `global.d.ts` + `App.tsx` local `ConnectionProfile`: `driver` union gains `'sqlserver'`.
- [ ] **Step 2:** `App.tsx`: widen `formDriver` state type; add `<option value="sqlserver">SQL Server</option>`; `handleDriverChange('sqlserver')` → `setFormPort(1433); setFormDatabase('master'); setFormUsername('sa')`; `DRIVER_LABEL` gains `sqlserver: 'MS'`. The host/port/username/password/TLS fields already render for non-sqlite drivers, so no new form layout is needed — confirm sqlserver falls into the same branch as mysql/postgres (NOT the sqlite branch).
- [ ] **Step 3:** Widen the dialog/data casts to include sqlserver: `SchemaExplorer.tsx` `driver as Driver` already includes sqlserver once `Driver` has it; `App.tsx` `<TableDataView driver={profile.driver as 'mysql' | 'postgres' | 'sqlite'}>` → add `| 'sqlserver'`; `TableDataView.tsx` Props.driver = `Driver` (already widens). `QueryEditor.tsx`: `DRIVER_LABEL` add `sqlserver: 'MS'`; add a sqlserver starter query branch (`SELECT name FROM sys.databases;`).
- [ ] **Step 4:** `tsc --noEmit`, `eslint src`, `vitest run`, `pnpm build` → all green.
- [ ] **Step 5: Commit** `feat(renderer): sqlserver connection form + driver wiring`.

## Phase S-V: Verify

### Task S-V1: Full build + live CDP verification

- [ ] **Step 1:** Full suites — engine `go build ./... && go test ./...` (with `SQLSERVER_TEST_DSN` set so integration tests run); renderer `tsc --noEmit && eslint src && vitest run && pnpm build`; desktop `tsc`.
- [ ] **Step 2:** Ensure Docker SQL Server is up and seeded with a demo DB (authors/books/view/index + rows).
- [ ] **Step 3:** Launch the dev app with `--remote-debugging-port=9222` (vite :5173 + electron; build the engine binary to `apps/desktop/bin/app-engine` first).
- [ ] **Step 4:** Drive via CDP (Node built-in WebSocket): create a sqlserver connection (host localhost, port 1433, user sa, password, database = the demo DB, TLS none), testConnection ok, connect, assert schema tree (tables/views/indexes/FK), run a SELECT (rows stream), page the table data view (OFFSET/FETCH), inline-edit a row and confirm persistence, view reconstructed table DDL, open the ER diagram, and create/alter/truncate a table via the dialogs. Screenshot. Clean up the test connection.
- [ ] **Step 5:** Tear down: kill electron/vite; `docker rm -f rebase-mssql`. Commit any fixes found.

## Self-Review (completed during planning)

- **Spec coverage:** §1 model → S-E1; §2 connector → S-E2 (DDL assembler) + S-E3a/b/c; §3 registration → S-E4; §4 renderer → S-R1 (builders) + S-R2 (form); §6 testing → integration tests per task + unit tests + S-V1; §7 scope (SQL auth, default-schema) honored.
- **Type consistency:** `SQLServerConnector`/`NewSQLServerConnector`, `DDLColumn`/`BuildCreateTableDDL`, `quoteIdent` (Go bracket helper in sqlserver_ddl.go; renderer `Driver` gains `'sqlserver'`), `SQLSERVER_TEST_DSN` are used consistently.
- **Known soft spots flagged:** exact catalog column names + go-mssqldb parameter binding style are nailed by the live integration TDD (S-E3a/b/c); the DDL assembler's exact spacing is pinned by its unit test (S-E2); pagination ORDER BY fallback is `(SELECT NULL)`.
