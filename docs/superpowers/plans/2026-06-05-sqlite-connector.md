# SQLite Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SQLite as a fully connectable database with feature parity to MySQL/PostgreSQL (connect, schema browsing, read/write queries, inline edit, ER diagram, multi-statement batches).

**Architecture:** A new `SQLiteConnector` in `engine/internal/adapters/sqlite/` implements the existing `ports.SQLConnector` interface using the already-bundled pure-Go `modernc.org/sqlite` driver. The file path is stored in `ConnectionProfile.Database`; a new `ReadOnly` field opens the file with `mode=ro`. Cancellation uses an in-memory session→`context.CancelFunc` registry (SQLite has no server-side KILL). The connector is registered in every driver switch (query/introspection/agent/profile handlers + MCP). The renderer connection form gains a sqlite branch (native file picker + read-only checkbox).

**Tech Stack:** Go 1.25 (`go` at `/Users/smlee/sdk/go/bin/go`), `modernc.org/sqlite`, React 19 + Vite, Electron 28.

**Conventions:** Run engine tests with `/Users/smlee/sdk/go/bin/go test ./...` from `engine/`. Commit messages use Conventional Commits and end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Work on branch `feat/sqlite-connector` (already created).

---

## File Structure

**New**
- `engine/internal/adapters/sqlite/sqlite_connector.go` — connectable-SQLite `ports.SQLConnector` implementation (distinct from the existing internal workspace/profile repos in this package).
- `engine/internal/adapters/sqlite/sqlite_connector_test.go` — hermetic tests against a seeded temp `.db`.

**Modified — engine**
- `engine/internal/domain/connection.go` — `ReadOnly` field + `Validate()` sqlite branch.
- `engine/internal/domain/connection_test.go` — sqlite validation tests.
- `engine/cmd/app-engine/main.go` — version-4 migration (`read_only` column) + MCP connector `sqlite` case.
- `engine/internal/adapters/sqlite/sqlite_profile_repository.go` — read/write `read_only` in INSERT/UPDATE/SELECT/Scan.
- `engine/internal/transport/http/query.go`, `introspection.go`, `agent.go`, `profile.go` — register sqlite connector.
- `engine/internal/agent/tools.go` — `quoteIdent` + `table_stats` sqlite branches.
- `go.mod` — promote `modernc.org/sqlite` to a direct dependency (via `go mod tidy`).

**Modified — desktop/renderer**
- `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts` — `pickSqliteFile` IPC.
- `apps/renderer/src/global.d.ts` — driver union, `readOnly`, `pickSqliteFile`.
- `apps/renderer/src/App.tsx` (+ `App.css`) — sqlite connection form branch + driver option.

---

## Phase E — Engine

### Task E1: Domain — `ReadOnly` field + sqlite validation

**Files:**
- Modify: `engine/internal/domain/connection.go`
- Test: `engine/internal/domain/connection_test.go`

- [ ] **Step 1: Write the failing tests**

Add to `engine/internal/domain/connection_test.go`:

```go
func TestValidate_SQLiteAcceptsFilePathWithoutHostPort(t *testing.T) {
	p := ConnectionProfile{Name: "local.db", Driver: "sqlite", Database: "/tmp/local.db"}
	if err := p.Validate(); err != nil {
		t.Fatalf("expected sqlite profile with a file path to be valid, got: %v", err)
	}
}

func TestValidate_SQLiteRequiresDatabasePath(t *testing.T) {
	p := ConnectionProfile{Name: "x", Driver: "sqlite", Database: ""}
	if err := p.Validate(); err == nil {
		t.Fatal("expected sqlite profile with empty Database (file path) to be invalid")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/domain/ -run TestValidate_SQLite -v`
Expected: FAIL — `unsupported database driver: sqlite`.

- [ ] **Step 3: Add the `ReadOnly` field**

In `engine/internal/domain/connection.go`, inside `ConnectionProfile`, add after the `TLSMode` field:

```go
	TLSMode   string    `json:"tlsMode"` // none, prefer, require
	// ReadOnly opens the database read-only (currently used by sqlite: mode=ro).
	ReadOnly        bool      `json:"readOnly"`
```

- [ ] **Step 4: Add the sqlite branch to `Validate()`**

Replace the body of `Validate()` with:

```go
func (p ConnectionProfile) Validate() error {
	if p.Name == "" {
		return errors.New("connection profile name is required")
	}
	if p.Driver != "mysql" && p.Driver != "postgres" && p.Driver != "redis" && p.Driver != "sqlite" {
		return errors.New("unsupported database driver: " + p.Driver)
	}
	// SQLite is a local file: the path lives in Database; host/port are unused.
	if p.Driver == "sqlite" {
		if p.Database == "" {
			return errors.New("database file path is required for sqlite")
		}
		return nil
	}
	if p.Host == "" {
		return errors.New("database host is required")
	}
	if p.Port <= 0 || p.Port > 65535 {
		return errors.New("invalid database port")
	}
	if (p.Driver == "mysql" || p.Driver == "postgres") && p.Database == "" {
		return errors.New("database name is required for relational databases")
	}
	return nil
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/domain/ -v`
Expected: PASS (all domain tests).

- [ ] **Step 6: Commit**

```bash
git add engine/internal/domain/connection.go engine/internal/domain/connection_test.go
git commit -m "feat(engine): accept sqlite driver + add ReadOnly profile field

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task E2: Profile repository — persist `read_only`

**Files:**
- Modify: `engine/cmd/app-engine/main.go` (migrations slice, ~line 85–164)
- Modify: `engine/internal/adapters/sqlite/sqlite_profile_repository.go`
- Test: `engine/internal/adapters/sqlite/sqlite_profile_repository_test.go`

- [ ] **Step 1: Write the failing test**

Add to `engine/internal/adapters/sqlite/sqlite_profile_repository_test.go` (mirror the existing test setup in that file for opening a temp DB + running migrations; reuse whatever helper the existing tests use to construct the repository). The test creates a sqlite profile with `ReadOnly: true`, stores it, reloads it, and asserts the flag round-trips:

```go
func TestProfileRepository_ReadOnlyRoundTrips(t *testing.T) {
	repo, cleanup := newTestProfileRepo(t) // existing helper in this test file
	defer cleanup()
	ctx := context.Background()

	p := &domain.ConnectionProfile{
		ID: "ro1", Name: "local", Driver: "sqlite", Host: "", Port: 0,
		Database: "/tmp/x.db", Username: "", SecretRef: "", TLSMode: "none",
		ReadOnly: true, CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := repo.Create(ctx, p); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := repo.GetByID(ctx, "ro1")
	if err != nil {
		t.Fatalf("getByID: %v", err)
	}
	if !got.ReadOnly {
		t.Fatalf("expected ReadOnly=true to round-trip, got false")
	}
}
```

> If the existing test file uses a different helper name than `newTestProfileRepo`, use that one. Open the file first and match the established setup pattern (it already constructs a `*SQLiteProfileRepository` over a migrated temp DB).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/adapters/sqlite/ -run TestProfileRepository_ReadOnly -v`
Expected: FAIL — `no such column: read_only` (or a Scan/column-count error).

- [ ] **Step 3: Add the version-4 migration**

In `engine/cmd/app-engine/main.go`, in the `migrations := []sqlite.Migration{...}` slice, add a new entry after the version-3 (`add_profile_mcp_settings`) entry:

```go
		{
			Version: 4,
			Name:    "add_profile_read_only",
			SQL: `
				ALTER TABLE connection_profiles ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
			`,
			Checksum: "profile-read-only-v1",
		},
```

- [ ] **Step 4: Read/write the column in the repository**

In `engine/internal/adapters/sqlite/sqlite_profile_repository.go`:

`Create` — add `read_only` to the column list and `p.ReadOnly` to the values (append at the end, before `created_at, updated_at`, keeping placeholders aligned):

```go
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO connection_profiles (id, name, driver, host, port, database, username, secret_ref, tls_mode, mcp_enabled, mcp_data_exposure, read_only, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, p.ID, p.Name, p.Driver, p.Host, p.Port, p.Database, p.Username, p.SecretRef, p.TLSMode, p.McpEnabled, p.McpDataExposure, p.ReadOnly, p.CreatedAt, p.UpdatedAt)
```

`Update` — add `read_only = ?` to the SET list and `p.ReadOnly` to the args (before `updated_at = ?`):

```go
	res, err := r.db.ExecContext(ctx, `
		UPDATE connection_profiles
		SET name = ?, driver = ?, host = ?, port = ?, database = ?, username = ?, secret_ref = ?, tls_mode = ?, mcp_enabled = ?, mcp_data_exposure = ?, read_only = ?, updated_at = ?
		WHERE id = ?
	`, p.Name, p.Driver, p.Host, p.Port, p.Database, p.Username, p.SecretRef, p.TLSMode, p.McpEnabled, p.McpDataExposure, p.ReadOnly, p.UpdatedAt, p.ID)
```

`GetByID` and any `List` query — add `read_only` to the SELECT column list and `&p.ReadOnly` to the matching `Scan(...)` call, positioned identically (after `mcp_data_exposure`, before `created_at`):

```go
	row := r.db.QueryRowContext(ctx, `
		SELECT id, name, driver, host, port, database, username, secret_ref, tls_mode, mcp_enabled, mcp_data_exposure, read_only, created_at, updated_at
		FROM connection_profiles WHERE id = ?
	`, id)

	var p domain.ConnectionProfile
	err := row.Scan(&p.ID, &p.Name, &p.Driver, &p.Host, &p.Port, &p.Database, &p.Username, &p.SecretRef, &p.TLSMode, &p.McpEnabled, &p.McpDataExposure, &p.ReadOnly, &p.CreatedAt, &p.UpdatedAt)
```

> Apply the same SELECT-column + Scan addition to **every** query in this file that reads profiles (e.g. a `List`/`GetAll` method). Search the file for `mcp_data_exposure` and update each occurrence consistently.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/adapters/sqlite/ -run TestProfileRepository -v`
Expected: PASS.

- [ ] **Step 6: Run the full sqlite package + domain to check nothing broke**

Run: `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/adapters/sqlite/ ./internal/domain/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add engine/cmd/app-engine/main.go engine/internal/adapters/sqlite/sqlite_profile_repository.go engine/internal/adapters/sqlite/sqlite_profile_repository_test.go
git commit -m "feat(engine): persist ReadOnly on connection profiles (migration v4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task E3a: SQLite connector — open + introspection (tables/views/DDL)

**Files:**
- Create: `engine/internal/adapters/sqlite/sqlite_connector.go`
- Test: `engine/internal/adapters/sqlite/sqlite_connector_test.go`

- [ ] **Step 1: Write the test helper + failing tests**

Create `engine/internal/adapters/sqlite/sqlite_connector_test.go`:

```go
package sqlite

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	_ "modernc.org/sqlite"
)

// seedDB creates a temp .db with two tables (FK), a view, and two indexes.
func seedDB(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatalf("open seed db: %v", err)
	}
	defer db.Close()
	stmts := []string{
		`CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`,
		`CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER REFERENCES authors(id))`,
		`CREATE VIEW book_titles AS SELECT title FROM books`,
		`CREATE UNIQUE INDEX idx_authors_name ON authors(name)`,
		`CREATE INDEX idx_books_author ON books(author_id)`,
		`INSERT INTO authors (id, name) VALUES (1, 'Ann'), (2, 'Bob')`,
		`INSERT INTO books (id, title, author_id) VALUES (1, 'Go', 1), (2, 'SQL', 2)`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("seed %q: %v", s, err)
		}
	}
	return path
}

func sqliteProfile(path string, readOnly bool) domain.ConnectionProfile {
	return domain.ConnectionProfile{Name: "t", Driver: "sqlite", Database: path, ReadOnly: readOnly}
}

func TestSQLite_TestConnection(t *testing.T) {
	c := NewSQLiteConnector()
	if err := c.TestConnection(context.Background(), sqliteProfile(seedDB(t), false), ""); err != nil {
		t.Fatalf("TestConnection: %v", err)
	}
}

func TestSQLite_ListDatabases_ListTables_ListViews(t *testing.T) {
	c := NewSQLiteConnector()
	p := sqliteProfile(seedDB(t), false)
	ctx := context.Background()

	dbs, err := c.ListDatabases(ctx, p, "")
	if err != nil || len(dbs) != 1 || dbs[0].Name != "test.db" {
		t.Fatalf("ListDatabases = %+v, err=%v", dbs, err)
	}
	tables, err := c.ListTables(ctx, p, "", "test.db")
	if err != nil {
		t.Fatalf("ListTables: %v", err)
	}
	if len(tables) != 2 || tables[0].Name != "authors" || tables[1].Name != "books" {
		t.Fatalf("ListTables = %+v", tables)
	}
	views, err := c.ListViews(ctx, p, "", "test.db")
	if err != nil || len(views) != 1 || views[0].Name != "book_titles" {
		t.Fatalf("ListViews = %+v, err=%v", views, err)
	}
}

func TestSQLite_GetTableDDL_GetViewDDL(t *testing.T) {
	c := NewSQLiteConnector()
	p := sqliteProfile(seedDB(t), false)
	ctx := context.Background()
	ddl, err := c.GetTableDDL(ctx, p, "", "test.db", "authors")
	if err != nil || ddl == "" {
		t.Fatalf("GetTableDDL = %q, err=%v", ddl, err)
	}
	vddl, err := c.GetViewDDL(ctx, p, "", "test.db", "book_titles")
	if err != nil || vddl == "" {
		t.Fatalf("GetViewDDL = %q, err=%v", vddl, err)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/adapters/sqlite/ -run TestSQLite_ -v`
Expected: FAIL — `undefined: NewSQLiteConnector`.

- [ ] **Step 3: Create the connector with open + part-1 introspection**

Create `engine/internal/adapters/sqlite/sqlite_connector.go`:

```go
package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"path/filepath"
	"strings"
	"sync"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
	_ "modernc.org/sqlite"
)

// SQLiteConnector implements ports.SQLConnector over a local SQLite file.
// The file path is carried in profile.Database; profile.ReadOnly opens mode=ro.
type SQLiteConnector struct {
	mu       sync.Mutex
	sessions map[int64]context.CancelFunc
	nextID   int64
}

func NewSQLiteConnector() *SQLiteConnector {
	return &SQLiteConnector{sessions: map[int64]context.CancelFunc{}}
}

// open returns a *sql.DB for the profile's file. readOnly (from the caller) is
// OR'd with profile.ReadOnly, so a read-only connection is always read-only.
func (c *SQLiteConnector) open(p domain.ConnectionProfile, readOnly bool) (*sql.DB, error) {
	v := url.Values{}
	v.Set("_pragma", "busy_timeout(5000)")
	if readOnly || p.ReadOnly {
		v.Set("mode", "ro")
	}
	dsn := (&url.URL{Scheme: "file", Path: p.Database, RawQuery: v.Encode()}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, c.normalizeError(err)
	}
	return db, nil
}

func (c *SQLiteConnector) TestConnection(ctx context.Context, p domain.ConnectionProfile, password string) error {
	db, err := c.open(p, true)
	if err != nil {
		return err
	}
	defer db.Close()
	var n int
	return c.normalizeError(db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master").Scan(&n))
}

func (c *SQLiteConnector) ListDatabases(ctx context.Context, p domain.ConnectionProfile, password string) ([]ports.DatabaseInfo, error) {
	return []ports.DatabaseInfo{{Name: filepath.Base(p.Database)}}, nil
}

func (c *SQLiteConnector) ListTables(ctx context.Context, p domain.ConnectionProfile, password string, database string) ([]ports.TableInfo, error) {
	return c.listMaster(ctx, p, "table")
}

func (c *SQLiteConnector) ListViews(ctx context.Context, p domain.ConnectionProfile, password string, database string) ([]ports.TableInfo, error) {
	return c.listMaster(ctx, p, "view")
}

func (c *SQLiteConnector) listMaster(ctx context.Context, p domain.ConnectionProfile, kind string) ([]ports.TableInfo, error) {
	db, err := c.open(p, true)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.QueryContext(ctx,
		`SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`, kind)
	if err != nil {
		return nil, c.normalizeError(err)
	}
	defer rows.Close()
	var list []ports.TableInfo
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, c.normalizeError(err)
		}
		list = append(list, ports.TableInfo{Name: name})
	}
	return list, c.normalizeError(rows.Err())
}

func (c *SQLiteConnector) GetTableDDL(ctx context.Context, p domain.ConnectionProfile, password string, database string, table string) (string, error) {
	return c.masterDDL(ctx, p, "table", table)
}

func (c *SQLiteConnector) GetViewDDL(ctx context.Context, p domain.ConnectionProfile, password string, database string, view string) (string, error) {
	return c.masterDDL(ctx, p, "view", view)
}

func (c *SQLiteConnector) masterDDL(ctx context.Context, p domain.ConnectionProfile, kind, name string) (string, error) {
	db, err := c.open(p, true)
	if err != nil {
		return "", err
	}
	defer db.Close()
	var ddl sql.NullString
	err = db.QueryRowContext(ctx,
		`SELECT sql FROM sqlite_master WHERE type = ? AND name = ?`, kind, name).Scan(&ddl)
	if err != nil {
		return "", c.normalizeError(err)
	}
	return ddl.String, nil
}

func (c *SQLiteConnector) normalizeError(err error) error {
	if err == nil {
		return nil
	}
	s := strings.ToLower(err.Error())
	switch {
	case strings.Contains(s, "no such file") || strings.Contains(s, "unable to open database"):
		return errors.New("database file not found or cannot be opened")
	case strings.Contains(s, "not a database"):
		return errors.New("the selected file is not a valid SQLite database")
	case strings.Contains(s, "readonly") || strings.Contains(s, "read-only") || strings.Contains(s, "read only"):
		return errors.New("this connection is read-only; writes are not allowed")
	case strings.Contains(s, "database is locked"):
		return errors.New("database is locked by another process; try again")
	}
	return err
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/adapters/sqlite/ -run TestSQLite_ -v`
Expected: PASS for the three E3a tests. (The package won't fully build yet because `SQLiteConnector` doesn't satisfy `ports.SQLConnector` — that's fine; these tests reference only implemented methods, so the test binary compiles. If Go complains about the unused interface, ignore — we assert the interface in E3c.)

> If the package fails to compile due to a later `var _ ports.SQLConnector` assertion, that assertion is added in E3c — do not add it yet.

- [ ] **Step 5: Commit**

```bash
git add engine/internal/adapters/sqlite/sqlite_connector.go engine/internal/adapters/sqlite/sqlite_connector_test.go
git commit -m "feat(engine): sqlite connector — open + tables/views/DDL introspection

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task E3b: SQLite connector — columns, FKs, indexes, schema graph

**Files:**
- Modify: `engine/internal/adapters/sqlite/sqlite_connector.go`
- Test: `engine/internal/adapters/sqlite/sqlite_connector_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `sqlite_connector_test.go`:

```go
func TestSQLite_DescribeTable(t *testing.T) {
	c := NewSQLiteConnector()
	p := sqliteProfile(seedDB(t), false)
	d, err := c.DescribeTable(context.Background(), p, "", "test.db", "books")
	if err != nil {
		t.Fatalf("DescribeTable: %v", err)
	}
	if len(d.Columns) != 3 {
		t.Fatalf("expected 3 columns, got %d (%+v)", len(d.Columns), d.Columns)
	}
	if d.Columns[0].Name != "id" || !d.Columns[0].PrimaryKey {
		t.Fatalf("col0 should be id PK, got %+v", d.Columns[0])
	}
	if d.Columns[1].Name != "title" || d.Columns[1].Nullable {
		t.Fatalf("title should be NOT NULL, got %+v", d.Columns[1])
	}
}

func TestSQLite_ListColumns(t *testing.T) {
	c := NewSQLiteConnector()
	p := sqliteProfile(seedDB(t), false)
	cols, err := c.ListColumns(context.Background(), p, "", "test.db")
	if err != nil {
		t.Fatalf("ListColumns: %v", err)
	}
	// 2 (authors) + 3 (books) = 5 column refs.
	if len(cols) != 5 {
		t.Fatalf("expected 5 column refs, got %d (%+v)", len(cols), cols)
	}
}

func TestSQLite_ListForeignKeys(t *testing.T) {
	c := NewSQLiteConnector()
	p := sqliteProfile(seedDB(t), false)
	fks, err := c.ListForeignKeys(context.Background(), p, "", "test.db", "books")
	if err != nil {
		t.Fatalf("ListForeignKeys: %v", err)
	}
	if len(fks) != 1 || fks[0].Column != "author_id" || fks[0].RefTable != "authors" || fks[0].RefColumn != "id" {
		t.Fatalf("unexpected FKs: %+v", fks)
	}
}

func TestSQLite_ListIndexes(t *testing.T) {
	c := NewSQLiteConnector()
	p := sqliteProfile(seedDB(t), false)
	idx, err := c.ListIndexes(context.Background(), p, "", "test.db", "authors")
	if err != nil {
		t.Fatalf("ListIndexes: %v", err)
	}
	var found *ports.Index
	for i := range idx {
		if idx[i].Name == "idx_authors_name" {
			found = &idx[i]
		}
	}
	if found == nil || !found.Unique || len(found.Columns) != 1 || found.Columns[0] != "name" {
		t.Fatalf("idx_authors_name not found/incorrect: %+v", idx)
	}
}

func TestSQLite_GetSchemaGraph(t *testing.T) {
	c := NewSQLiteConnector()
	p := sqliteProfile(seedDB(t), false)
	g, err := c.GetSchemaGraph(context.Background(), p, "", "test.db")
	if err != nil {
		t.Fatalf("GetSchemaGraph: %v", err)
	}
	if len(g.Tables) != 2 {
		t.Fatalf("expected 2 tables, got %d", len(g.Tables))
	}
	if len(g.ForeignKeys) != 1 || g.ForeignKeys[0].FromTable != "books" || g.ForeignKeys[0].ToTable != "authors" {
		t.Fatalf("unexpected FKs: %+v", g.ForeignKeys)
	}
}
```

The test file imports must include `"github.com/smlee/database-local-engine/engine/internal/ports"` (add it to the import block).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/adapters/sqlite/ -run 'TestSQLite_(DescribeTable|ListColumns|ListForeignKeys|ListIndexes|GetSchemaGraph)' -v`
Expected: FAIL — `c.DescribeTable undefined` (and the others).

- [ ] **Step 3: Implement the part-2 introspection methods**

Append to `sqlite_connector.go`. These use SQLite **table-valued PRAGMA functions** (`pragma_table_info(?)` etc.), which accept a bound parameter — no manual identifier escaping needed. Keyword columns (`notnull`, `unique`, `from`, `to`, `table`) are double-quoted.

```go
func (c *SQLiteConnector) DescribeTable(ctx context.Context, p domain.ConnectionProfile, password string, database string, table string) (ports.TableDescription, error) {
	db, err := c.open(p, true)
	if err != nil {
		return ports.TableDescription{}, err
	}
	defer db.Close()
	cols, err := tableColumns(ctx, db, table)
	if err != nil {
		return ports.TableDescription{}, c.normalizeError(err)
	}
	return ports.TableDescription{Columns: cols}, nil
}

// tableColumns reads PRAGMA table_info for one table.
func tableColumns(ctx context.Context, db *sql.DB, table string) ([]ports.ColumnInfo, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT name, type, "notnull", pk FROM pragma_table_info(?)`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var cols []ports.ColumnInfo
	for rows.Next() {
		var name, typ string
		var notnull, pk int
		if err := rows.Scan(&name, &typ, &notnull, &pk); err != nil {
			return nil, err
		}
		cols = append(cols, ports.ColumnInfo{Name: name, Type: typ, Nullable: notnull == 0, PrimaryKey: pk > 0})
	}
	return cols, rows.Err()
}

func (c *SQLiteConnector) ListColumns(ctx context.Context, p domain.ConnectionProfile, password string, database string) ([]ports.ColumnRef, error) {
	db, err := c.open(p, true)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	tables, err := c.tableNames(ctx, db)
	if err != nil {
		return nil, c.normalizeError(err)
	}
	var refs []ports.ColumnRef
	for _, t := range tables {
		cols, err := tableColumns(ctx, db, t)
		if err != nil {
			return nil, c.normalizeError(err)
		}
		for _, col := range cols {
			refs = append(refs, ports.ColumnRef{Table: t, Column: col.Name, Type: col.Type})
		}
	}
	return refs, nil
}

// tableNames lists base tables (used internally where a *sql.DB is already open).
func (c *SQLiteConnector) tableNames(ctx context.Context, db *sql.DB) ([]string, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		names = append(names, n)
	}
	return names, rows.Err()
}

func (c *SQLiteConnector) ListForeignKeys(ctx context.Context, p domain.ConnectionProfile, password string, database string, table string) ([]ports.ForeignKey, error) {
	db, err := c.open(p, true)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	fks, err := tableForeignKeys(ctx, db, table)
	if err != nil {
		return nil, c.normalizeError(err)
	}
	return fks, nil
}

func tableForeignKeys(ctx context.Context, db *sql.DB, table string) ([]ports.ForeignKey, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT "from", "table", "to" FROM pragma_foreign_key_list(?)`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []ports.ForeignKey
	for rows.Next() {
		var fk ports.ForeignKey
		if err := rows.Scan(&fk.Column, &fk.RefTable, &fk.RefColumn); err != nil {
			return nil, err
		}
		list = append(list, fk)
	}
	return list, rows.Err()
}

func (c *SQLiteConnector) ListIndexes(ctx context.Context, p domain.ConnectionProfile, password string, database string, table string) ([]ports.Index, error) {
	db, err := c.open(p, true)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.QueryContext(ctx,
		`SELECT name, "unique", origin FROM pragma_index_list(?)`, table)
	if err != nil {
		return nil, c.normalizeError(err)
	}
	defer rows.Close()
	type idxMeta struct {
		name    string
		unique  bool
		primary bool
	}
	var metas []idxMeta
	for rows.Next() {
		var name, origin string
		var uniq int
		if err := rows.Scan(&name, &uniq, &origin); err != nil {
			return nil, c.normalizeError(err)
		}
		metas = append(metas, idxMeta{name: name, unique: uniq == 1, primary: origin == "pk"})
	}
	if err := rows.Err(); err != nil {
		return nil, c.normalizeError(err)
	}
	var list []ports.Index
	for _, m := range metas {
		colRows, err := db.QueryContext(ctx, `SELECT name FROM pragma_index_info(?) ORDER BY seqno`, m.name)
		if err != nil {
			return nil, c.normalizeError(err)
		}
		var cols []string
		for colRows.Next() {
			var cn string
			if err := colRows.Scan(&cn); err != nil {
				colRows.Close()
				return nil, c.normalizeError(err)
			}
			cols = append(cols, cn)
		}
		colRows.Close()
		list = append(list, ports.Index{Name: m.name, Columns: cols, Unique: m.unique, Primary: m.primary})
	}
	return list, nil
}

func (c *SQLiteConnector) GetSchemaGraph(ctx context.Context, p domain.ConnectionProfile, password string, database string) (ports.SchemaGraph, error) {
	db, err := c.open(p, true)
	if err != nil {
		return ports.SchemaGraph{}, err
	}
	defer db.Close()
	tables, err := c.tableNames(ctx, db)
	if err != nil {
		return ports.SchemaGraph{}, c.normalizeError(err)
	}
	var g ports.SchemaGraph
	for _, t := range tables {
		cols, err := tableColumns(ctx, db, t)
		if err != nil {
			return ports.SchemaGraph{}, c.normalizeError(err)
		}
		g.Tables = append(g.Tables, ports.SchemaGraphTable{Name: t, Columns: cols})
		fks, err := tableForeignKeys(ctx, db, t)
		if err != nil {
			return ports.SchemaGraph{}, c.normalizeError(err)
		}
		for _, fk := range fks {
			g.ForeignKeys = append(g.ForeignKeys, ports.SchemaGraphFK{
				FromTable: t, FromColumn: fk.Column, ToTable: fk.RefTable, ToColumn: fk.RefColumn,
			})
		}
	}
	return g, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/adapters/sqlite/ -run TestSQLite_ -v`
Expected: PASS (E3a + E3b tests).

- [ ] **Step 5: Commit**

```bash
git add engine/internal/adapters/sqlite/sqlite_connector.go engine/internal/adapters/sqlite/sqlite_connector_test.go
git commit -m "feat(engine): sqlite connector — columns, FKs, indexes, schema graph

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task E3c: SQLite connector — query stream, batch, cancel, read-only enforcement

**Files:**
- Modify: `engine/internal/adapters/sqlite/sqlite_connector.go`
- Test: `engine/internal/adapters/sqlite/sqlite_connector_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `sqlite_connector_test.go`:

```go
func TestSQLite_ExecuteQueryStream_Select(t *testing.T) {
	c := NewSQLiteConnector()
	p := sqliteProfile(seedDB(t), false)
	var cols []string
	var rowCount int
	n, err := c.ExecuteQueryStream(context.Background(), p, "",
		"SELECT id, name FROM authors ORDER BY id", true,
		nil,
		func(h []string) error { cols = h; return nil },
		func(r []any) error { rowCount++; return nil },
	)
	if err != nil {
		t.Fatalf("ExecuteQueryStream: %v", err)
	}
	if len(cols) != 2 || cols[0] != "id" || cols[1] != "name" {
		t.Fatalf("header = %+v", cols)
	}
	if rowCount != 2 || n != 2 {
		t.Fatalf("rowCount=%d n=%d", rowCount, n)
	}
}

func TestSQLite_ReadOnlyRejectsWrite(t *testing.T) {
	c := NewSQLiteConnector()
	p := sqliteProfile(seedDB(t), true) // ReadOnly profile
	_, err := c.ExecuteQueryStream(context.Background(), p, "",
		"INSERT INTO authors (id, name) VALUES (3, 'Cara')", false,
		nil, func([]string) error { return nil }, func([]any) error { return nil })
	if err == nil {
		t.Fatal("expected a read-only write to be rejected")
	}
	if !strings.Contains(err.Error(), "read-only") {
		t.Fatalf("expected a read-only error, got: %v", err)
	}
}

func TestSQLite_ExecuteBatch_AtomicRollback(t *testing.T) {
	c := NewSQLiteConnector()
	path := seedDB(t)
	p := sqliteProfile(path, false)
	ctx := context.Background()
	// 2nd statement violates the PK → whole batch rolls back.
	_, failedIndex, err := c.ExecuteBatch(ctx, p, "", []string{
		"INSERT INTO authors (id, name) VALUES (10, 'X')",
		"INSERT INTO authors (id, name) VALUES (1, 'dup-pk')",
	})
	if err == nil || failedIndex != 1 {
		t.Fatalf("expected failedIndex=1 with error, got idx=%d err=%v", failedIndex, err)
	}
	// Assert the first insert was rolled back (id=10 absent).
	var cnt int
	_, qerr := c.ExecuteQueryStream(ctx, p, "", "SELECT count(*) FROM authors WHERE id = 10", true,
		nil, func([]string) error { return nil },
		func(r []any) error { cnt = int(toI64(r[0])); return nil })
	if qerr != nil {
		t.Fatalf("verify query: %v", qerr)
	}
	if cnt != 0 {
		t.Fatalf("expected rollback (id=10 absent), found %d", cnt)
	}
}

func TestSQLite_ExecuteBatch_CommitsOnSuccess(t *testing.T) {
	c := NewSQLiteConnector()
	p := sqliteProfile(seedDB(t), false)
	ctx := context.Background()
	total, failedIndex, err := c.ExecuteBatch(ctx, p, "", []string{
		"INSERT INTO authors (id, name) VALUES (20, 'Y')",
		"UPDATE authors SET name = 'Y2' WHERE id = 20",
	})
	if err != nil || failedIndex != -1 {
		t.Fatalf("expected success, got idx=%d err=%v", failedIndex, err)
	}
	if total < 2 {
		t.Fatalf("expected >=2 rows affected, got %d", total)
	}
}

// toI64 coerces a scanned numeric cell to int64 (SQLite returns int64 for counts).
func toI64(v any) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	default:
		return 0
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/adapters/sqlite/ -run 'TestSQLite_(ExecuteQueryStream|ReadOnly|ExecuteBatch)' -v`
Expected: FAIL — `c.ExecuteQueryStream undefined`.

- [ ] **Step 3: Implement query stream, batch, cancel + interface assertion**

Append to `sqlite_connector.go`:

```go
func (c *SQLiteConnector) register(cancel context.CancelFunc) int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.nextID++
	id := c.nextID
	c.sessions[id] = cancel
	return id
}

func (c *SQLiteConnector) deregister(id int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.sessions, id)
}

func (c *SQLiteConnector) ExecuteQueryStream(
	ctx context.Context,
	p domain.ConnectionProfile,
	password string,
	query string,
	readOnly bool,
	onSessionStart func(sessionID int64),
	onHeader func(columns []string) error,
	onRow func(row []any) error,
) (int64, error) {
	db, err := c.open(p, readOnly)
	if err != nil {
		return 0, err
	}
	defer db.Close()

	// SQLite has no server-side KILL; cancellation is via context. Register the
	// cancel func under a session id so CancelSession can abort an in-flight query.
	qctx, cancel := context.WithCancel(ctx)
	defer cancel()
	id := c.register(cancel)
	defer c.deregister(id)
	if onSessionStart != nil {
		onSessionStart(id)
	}

	rows, err := db.QueryContext(qctx, query)
	if err != nil {
		return 0, c.normalizeError(err)
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return 0, c.normalizeError(err)
	}
	if err := onHeader(cols); err != nil {
		return 0, err
	}

	values := make([]any, len(cols))
	valuePtrs := make([]any, len(cols))
	for i := range values {
		valuePtrs[i] = &values[i]
	}

	var rowsAffected int64
	for rows.Next() {
		if err := rows.Scan(valuePtrs...); err != nil {
			return rowsAffected, c.normalizeError(err)
		}
		row := make([]any, len(values))
		for i, val := range values {
			if b, ok := val.([]byte); ok {
				row[i] = string(b)
			} else {
				row[i] = val
			}
		}
		if err := onRow(row); err != nil {
			return rowsAffected, err
		}
		rowsAffected++
	}
	return rowsAffected, c.normalizeError(rows.Err())
}

func (c *SQLiteConnector) CancelSession(ctx context.Context, p domain.ConnectionProfile, password string, sessionID int64) error {
	c.mu.Lock()
	cancel := c.sessions[sessionID]
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return nil
}

// ExecuteBatch runs all statements in a single transaction. On the first failure
// it rolls back and returns the 0-based failed index; on success it commits and
// returns total rows affected with failedIndex -1.
func (c *SQLiteConnector) ExecuteBatch(ctx context.Context, p domain.ConnectionProfile, password string, statements []string) (int64, int, error) {
	db, err := c.open(p, false)
	if err != nil {
		return 0, -1, err
	}
	defer db.Close()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, -1, c.normalizeError(err)
	}
	var total int64
	for i, stmt := range statements {
		res, execErr := tx.ExecContext(ctx, stmt)
		if execErr != nil {
			_ = tx.Rollback()
			return total, i, c.normalizeError(execErr)
		}
		if n, aerr := res.RowsAffected(); aerr == nil {
			total += n
		}
	}
	if err := tx.Commit(); err != nil {
		return total, -1, c.normalizeError(err)
	}
	return total, -1, nil
}

// Compile-time assertion that SQLiteConnector satisfies the full SQL port.
var _ ports.SQLConnector = (*SQLiteConnector)(nil)
```

- [ ] **Step 4: Run the full sqlite connector test suite**

Run: `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/adapters/sqlite/ -run TestSQLite_ -v`
Expected: PASS (all connector tests, including read-only rejection and atomic rollback).

- [ ] **Step 5: Build the whole engine**

Run: `cd engine && /Users/smlee/sdk/go/bin/go build ./...`
Expected: no output (success). The `var _ ports.SQLConnector` assertion confirms full interface coverage.

- [ ] **Step 6: Commit**

```bash
git add engine/internal/adapters/sqlite/sqlite_connector.go engine/internal/adapters/sqlite/sqlite_connector_test.go
git commit -m "feat(engine): sqlite connector — query stream, batch, cancel, read-only

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task E4: Register the sqlite connector in every driver switch

**Files:**
- Modify: `engine/internal/transport/http/query.go`
- Modify: `engine/internal/transport/http/introspection.go`
- Modify: `engine/internal/transport/http/agent.go`
- Modify: `engine/internal/transport/http/profile.go`
- Modify: `engine/cmd/app-engine/main.go`
- Modify: `go.mod` (via `go mod tidy`)

- [ ] **Step 1: `query.go` — field, constructor, switch**

Add the import `"github.com/smlee/database-local-engine/engine/internal/adapters/sqlite"` to the import block. Then:

Struct — add the field:
```go
type QueryHandler struct {
	token             string
	service           *application.ConnectionService
	mysqlConnector    *mysql.MySQLConnector
	postgresConnector *postgres.PostgreSQLConnector
	sqliteConnector   *sqlite.SQLiteConnector
}
```
Constructor — construct it:
```go
	return &QueryHandler{
		token:             token,
		service:           service,
		mysqlConnector:    mysql.NewMySQLConnector(),
		postgresConnector: postgres.NewPostgreSQLConnector(),
		sqliteConnector:   sqlite.NewSQLiteConnector(),
	}
```
`getConnector` — add the case:
```go
	case "postgres":
		return h.postgresConnector, nil
	case "sqlite":
		return h.sqliteConnector, nil
```

- [ ] **Step 2: `introspection.go` — same three edits**

Add the `sqlite` import, the `sqliteConnector *sqlite.SQLiteConnector` field, `sqliteConnector: sqlite.NewSQLiteConnector()` in the constructor, and `case "sqlite": return h.sqliteConnector, nil` in `getConnector`.

- [ ] **Step 3: `agent.go` — same three edits**

Add the `sqlite` import, the `sqliteConnector *sqlite.SQLiteConnector` field, `sqliteConnector: sqlite.NewSQLiteConnector()` in the constructor (near the existing `mysqlConnector:`/`postgresConnector:` lines), and in `getConnector`:
```go
	case "postgres":
		return h.postgresConnector, nil
	case "sqlite":
		return h.sqliteConnector, nil
```

- [ ] **Step 4: `profile.go` — TestConnection switch**

Add the `sqlite` import, add a `sqliteConnector *sqlite.SQLiteConnector` field to `ProfileHandler`, construct it in `NewProfileHandler` (alongside the others), and add a case to the `switch profile.Driver` in `TestConnection`:
```go
		case "redis":
			err = h.redisConnector.TestConnection(r.Context(), profile, password)
		case "sqlite":
			err = h.sqliteConnector.TestConnection(r.Context(), profile, password)
```

- [ ] **Step 5: `main.go` — MCP connector case**

In `runMCPServer`, add to the `switch profile.Driver`:
```go
	case "postgres":
		conn = postgres.NewPostgreSQLConnector()
	case "sqlite":
		conn = sqlite.NewSQLiteConnector()
```
(The `sqlite` package is already imported in `main.go`.)

- [ ] **Step 6: Promote the driver to a direct dependency**

Run: `cd engine && /Users/smlee/sdk/go/bin/go mod tidy`
Expected: `go.mod` updates so `modernc.org/sqlite` is no longer marked `// indirect`.

- [ ] **Step 7: Build + run the full engine test suite**

Run: `cd engine && /Users/smlee/sdk/go/bin/go build ./... && /Users/smlee/sdk/go/bin/go test ./...`
Expected: build succeeds; all tests pass (integration tests needing live MySQL/Postgres/Redis may skip — that is expected, the sqlite tests are hermetic).

- [ ] **Step 8: Commit**

```bash
git add engine/internal/transport/http/query.go engine/internal/transport/http/introspection.go engine/internal/transport/http/agent.go engine/internal/transport/http/profile.go engine/cmd/app-engine/main.go go.mod go.sum
git commit -m "feat(engine): register sqlite connector in all driver switches

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task E5: Agent tools — sqlite identifier quoting + table stats

**Files:**
- Modify: `engine/internal/agent/tools.go`
- Test: `engine/internal/agent/tools_test.go` (if present; otherwise add a focused test file)

- [ ] **Step 1: Write the failing test**

Add (to `engine/internal/agent/tools_test.go`, or create `engine/internal/agent/quoteident_test.go` with `package agent`):

```go
func TestQuoteIdent_SQLiteUsesDoubleQuotes(t *testing.T) {
	got := quoteIdent("sqlite", `we"ird`)
	want := `"we""ird"`
	if got != want {
		t.Fatalf("quoteIdent sqlite = %q, want %q", got, want)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/agent/ -run TestQuoteIdent_SQLite -v`
Expected: FAIL — sqlite falls through to the backtick branch, producing `` `we"ird` ``.

- [ ] **Step 3: Update `quoteIdent`**

```go
func quoteIdent(driver, ident string) string {
	if driver == "postgres" || driver == "sqlite" {
		return `"` + strings.ReplaceAll(ident, `"`, `""`) + `"`
	}
	return "`" + strings.ReplaceAll(ident, "`", "``") + "`"
}
```

- [ ] **Step 4: Add a sqlite branch to the `table_stats` tool**

In the `table_stats` tool's `Run`, extend the driver branch (SQLite has no `information_schema`; use a row count with 0 bytes):

```go
		var sql string
		if p.Driver == "postgres" {
			sql = "SELECT c.reltuples::bigint AS rows, pg_total_relation_size(c.oid) AS bytes " +
				"FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
				"WHERE c.relname = " + lit + " AND n.nspname = current_schema()"
		} else if p.Driver == "sqlite" {
			sql = "SELECT (SELECT COUNT(*) FROM " + quoteIdent(p.Driver, table) + ") AS rows, 0 AS bytes"
		} else {
			sql = "SELECT table_rows AS rows, data_length + index_length AS bytes " +
				"FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = " + lit
		}
```

- [ ] **Step 5: Run the agent tests + build**

Run: `cd engine && /Users/smlee/sdk/go/bin/go test ./internal/agent/ && /Users/smlee/sdk/go/bin/go build ./...`
Expected: PASS + build success.

- [ ] **Step 6: Commit**

```bash
git add engine/internal/agent/tools.go engine/internal/agent/*_test.go
git commit -m "feat(engine): sqlite identifier quoting + table_stats branch in agent tools

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase D — Desktop IPC

### Task D1: `pickSqliteFile` native file picker

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/renderer/src/global.d.ts`

- [ ] **Step 1: Add the main-process handler**

In `apps/desktop/src/main/index.ts`, confirm `dialog` is in the electron import (`import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';`). Add this handler next to the other `ipcMain.handle(...)` blocks (e.g. near `create-profile`):

```typescript
ipcMain.handle('pick-sqlite-file', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'SQLite Databases', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
```

- [ ] **Step 2: Expose it in preload**

In `apps/desktop/src/preload/index.ts`, add to the `electronAPI` object (next to `createProfile`):

```typescript
  pickSqliteFile: () => ipcRenderer.invoke('pick-sqlite-file'),
```

- [ ] **Step 3: Type it in the renderer**

In `apps/renderer/src/global.d.ts`, add to the `electronAPI` interface (next to `createProfile`):

```typescript
      pickSqliteFile: () => Promise<string | null>;
```

- [ ] **Step 4: Compile the desktop main/preload**

Run: `cd apps/desktop && npx tsc`
Expected: no output (success).

- [ ] **Step 5: Type-check the renderer**

Run: `cd apps/renderer && npx tsc --noEmit`
Expected: no output (success).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/renderer/src/global.d.ts
git commit -m "feat(desktop): pickSqliteFile IPC (native open dialog)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase R — Renderer

### Task R1: Types — driver union + readOnly

**Files:**
- Modify: `apps/renderer/src/global.d.ts`

- [ ] **Step 1: Extend `ConnectionProfile`**

In `apps/renderer/src/global.d.ts`, update the interface:

```typescript
export interface ConnectionProfile {
  id?: string;
  name: string;
  driver: 'mysql' | 'postgres' | 'redis' | 'sqlite';
  host: string;
  port: number;
  database: string;
  username: string;
  secretRef?: string;
  tlsMode: 'none' | 'prefer' | 'require';
  readOnly?: boolean;
  mcpEnabled?: boolean;
  mcpDataExposure?: string;
  createdAt?: string;
  updatedAt?: string;
}
```

- [ ] **Step 2: Type-check**

Run: `cd apps/renderer && npx tsc --noEmit`
Expected: errors in `App.tsx` where `formDriver` is typed `'mysql' | 'postgres' | 'redis'` (these are fixed in R2). If the ONLY errors are about the driver union in App.tsx, that's expected — proceed to R2 before committing.

> Do not commit R1 alone; it is committed together with R2 (they are one coherent change).

---

### Task R2: Connection form — sqlite branch

**Files:**
- Modify: `apps/renderer/src/App.tsx`
- Modify: `apps/renderer/src/App.css`

- [ ] **Step 1: Widen the form-driver type + add read-only state**

In `App.tsx`, update the driver state type and add a read-only state next to the other form states:

```typescript
const [formDriver, setFormDriver] = useState<'mysql' | 'postgres' | 'redis' | 'sqlite'>('mysql');
```
Add (next to `formTlsMode`):
```typescript
const [formReadOnly, setFormReadOnly] = useState(false);
```

- [ ] **Step 2: Add the SQLite badge label**

Update `DRIVER_LABEL`:
```typescript
const DRIVER_LABEL: Record<string, string> = { mysql: 'MY', postgres: 'PG', redis: 'RS', sqlite: 'SQ' };
```

- [ ] **Step 3: Extend the driver `<select>` + change handler signature**

Driver select — add the option and widen the cast:
```tsx
<select value={formDriver} onChange={(e) => handleDriverChange(e.target.value as 'mysql' | 'postgres' | 'redis' | 'sqlite')}>
  <option value="mysql">MySQL</option>
  <option value="postgres">PostgreSQL</option>
  <option value="redis">Redis</option>
  <option value="sqlite">SQLite</option>
</select>
```
`handleDriverChange` — widen the param type and add the sqlite branch:
```typescript
const handleDriverChange = (driver: 'mysql' | 'postgres' | 'redis' | 'sqlite') => {
  setFormDriver(driver);
  if (driver === 'mysql') {
    setFormPort(3306);
    setFormDatabase('dev-mysql');
    setFormUsername('root');
  } else if (driver === 'postgres') {
    setFormPort(5432);
    setFormDatabase('postgres');
    setFormUsername('postgres');
  } else if (driver === 'sqlite') {
    setFormPort(0);
    setFormDatabase('');
    setFormUsername('');
  } else {
    setFormPort(6379);
    setFormDatabase('');
    setFormUsername('');
  }
};
```

- [ ] **Step 4: Branch the form body for sqlite**

Wrap the existing host/port/username/password/TLS/database fields so they only render for non-sqlite drivers, and render a sqlite-specific block otherwise. Replace the host/port row + database field + username/password + TLS group with:

```tsx
{formDriver === 'sqlite' ? (
  <>
    <div>
      <label>Database file</label>
      <div className="field-row">
        <input
          className="field-grow"
          type="text"
          value={formDatabase}
          onChange={(e) => setFormDatabase(e.target.value)}
          placeholder="/path/to/database.db"
          required
        />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={async () => {
            const path = await window.electronAPI.pickSqliteFile();
            if (path) setFormDatabase(path);
          }}
        >
          찾아보기
        </button>
      </div>
    </div>
    <div className="field-check">
      <label>
        <input type="checkbox" checked={formReadOnly} onChange={(e) => setFormReadOnly(e.target.checked)} />
        읽기 전용 (read-only)
      </label>
    </div>
  </>
) : (
  <>
    {/* existing host/port row, database field, username, password, TLS group — unchanged */}
  </>
)}
```

> Move the current host/port/username/password/TLS/database JSX verbatim into the `: (` branch. Do not duplicate it.

- [ ] **Step 5: Include `readOnly` (+ sqlite-safe host/port) when building the profile**

In the submit handler that builds the `ConnectionProfile`, set `readOnly` and make host/port sqlite-safe:

```typescript
const profile: ConnectionProfile = {
  name: formName,
  driver: formDriver,
  host: formDriver === 'sqlite' ? '' : formHost,
  port: formDriver === 'sqlite' ? 0 : formPort,
  database: formDatabase,
  username: formDriver === 'sqlite' ? '' : formUsername,
  tlsMode: formTlsMode,
  readOnly: formReadOnly,
};
```

- [ ] **Step 6: Load `readOnly` when editing an existing profile**

Find the code that populates the form when editing a saved connection (it sets `setFormDriver`, `setFormDatabase`, etc. from the profile). Add:
```typescript
setFormReadOnly(profile.readOnly ?? false);
```
And ensure `setFormDriver(profile.driver)` accepts `'sqlite'` (now that the union is widened).

- [ ] **Step 7: Add CSS for the read-only checkbox row**

In `apps/renderer/src/App.css`, add:
```css
.field-check {
  margin: 8px 0;
}
.field-check label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
}
.field-check input[type='checkbox'] {
  width: auto;
  margin: 0;
}
```

- [ ] **Step 8: Type-check, lint, build**

Run: `cd apps/renderer && npx tsc --noEmit && npx eslint src/App.tsx && pnpm build`
Expected: all pass; `built in ...`.

- [ ] **Step 9: Commit (R1 + R2 together)**

```bash
git add apps/renderer/src/global.d.ts apps/renderer/src/App.tsx apps/renderer/src/App.css
git commit -m "feat(renderer): sqlite connection form (file picker + read-only)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase V — Verify

### Task V1: Full build + live CDP verification

**Files:** none (verification only)

- [ ] **Step 1: Run every suite**

```bash
cd engine && /Users/smlee/sdk/go/bin/go build ./... && /Users/smlee/sdk/go/bin/go test ./...
cd ../apps/renderer && npx tsc --noEmit && npx eslint src && npx vitest run && pnpm build
cd ../desktop && npx tsc
```
Expected: engine builds + tests pass (live-DB integration tests may skip); renderer tsc/eslint/vitest/build pass; desktop tsc passes.

- [ ] **Step 2: Create a seeded SQLite file for manual testing**

```bash
python3 - <<'PY'
import sqlite3, os
p = os.path.expanduser('~/rebase-sqlite-demo.db')
if os.path.exists(p): os.remove(p)
c = sqlite3.connect(p); cur = c.cursor()
cur.executescript('''
CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER REFERENCES authors(id));
CREATE VIEW book_titles AS SELECT title FROM books;
CREATE UNIQUE INDEX idx_authors_name ON authors(name);
INSERT INTO authors (id,name) VALUES (1,'Ann'),(2,'Bob');
INSERT INTO books (id,title,author_id) VALUES (1,'Go',1),(2,'SQL',2);
''')
c.commit(); c.close(); print('wrote', p)
PY
```

- [ ] **Step 3: Launch the dev app with remote debugging**

Start the vite dev server and electron with `--remote-debugging-port=9222` (same procedure used previously: `cd apps/renderer && npx vite --port 5173` in the background; `cd apps/desktop && npx tsc && npx electron . --remote-debugging-port=9222`). Wait for `http://localhost:9222/json` to list the `localhost:5173` page.

- [ ] **Step 4: Drive the UI via CDP (Node built-in WebSocket)**

Using the established CDP harness (Node 24 global `WebSocket`, evaluate `window.electronAPI.*` / DOM), verify end to end:
1. Create a SQLite connection: set driver=sqlite, set `formDatabase` to `~/rebase-sqlite-demo.db` (the Browse button opens a native dialog that CDP can't drive, so set the path field's value directly for the automated check), `readOnly=false`, and submit (`createProfile`). Then **test connection** returns success.
2. Connect and assert the schema tree shows `authors`, `books` (tables), `book_titles` (view), and `idx_authors_name` (index).
3. Run `SELECT * FROM authors` and assert 2 rows stream back.
4. Open the ER diagram and assert the `books → authors` FK edge is present.
5. Edit the connection, enable read-only, reconnect, attempt `INSERT INTO authors (id,name) VALUES (3,'C')`, and assert the error contains "read-only".
6. On a writable connection, perform one inline cell edit (e.g. rename author 1 to "Ann2") and assert it persists on re-query.
Capture a screenshot of the connected SQLite session.

- [ ] **Step 5: Clean up**

Kill electron + vite; `rm -f ~/rebase-sqlite-demo.db`.

- [ ] **Step 6: Final commit (if verification required any fixes)**

Commit any fixes discovered during verification with a `fix(...)` message. If no fixes were needed, skip.

---

## Self-Review (completed during planning)

- **Spec coverage:** §1 data model → E1/E2; §2 connector → E3a/b/c; §3 driver registration → E4 (+ E5 agent tools); §4 renderer → R1/R2; §5 IPC → D1; §6 error handling → E3a `normalizeError`; §7 testing → tests in every E task + V1; §8 scope (open existing, single DB) → honored (no create-new, single `ListDatabases` entry).
- **Type consistency:** `SQLiteConnector`/`NewSQLiteConnector`, `tableColumns`/`tableForeignKeys`/`tableNames`, `ReadOnly` (Go) ↔ `readOnly` (JSON/TS), `pickSqliteFile` are used identically across tasks.
- **No placeholders:** every code step shows real, copyable code; the one "move existing JSX verbatim" instruction (R2 Step 4) references concrete existing fields, not a vague TODO.
- **Known soft spots flagged for the implementer:** the exact profile-repo test helper name (E2 Step 1) and the precise location of the edit-load block (R2 Step 6) must be matched against the real files; the DSN form (`file:` URL with `_pragma`/`mode=ro`) is validated by the very first connector test (E3a) and adjusted there if modernc needs a different encoding.
