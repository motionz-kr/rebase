package sqlsession

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func openTestDB(t *testing.T) (string, *sql.DB) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sessions.db")
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`); err != nil {
		db.Close()
		t.Fatal(err)
	}
	return path, db
}

func openReadOnlyTestDB(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	return db
}

func runSessionStatement(t *testing.T, manager *Manager, owner, database, id string, readOnly bool, query string) error {
	t.Helper()
	lease, err := manager.Query(context.Background(), owner, database, id, readOnly, query)
	if err != nil {
		return err
	}
	defer lease.Close()
	for lease.Rows.Next() {
		var ignored any
		if err := lease.Rows.Scan(&ignored); err != nil {
			return err
		}
	}
	return lease.Rows.Err()
}

func countItems(t *testing.T, path string) int {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM items`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestManagerPersistsTransactionAcrossQueriesAndCommitsOrRollsBack(t *testing.T) {
	ctx := context.Background()
	path, db := openTestDB(t)
	manager := NewManager(time.Hour)
	id, err := manager.Open(ctx, "profile-1", path, db, false)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close("profile-1", id)

	if err := runSessionStatement(t, manager, "profile-1", path, id, false, `INSERT INTO items(name) VALUES ('commit me')`); err != nil {
		t.Fatal(err)
	}
	if err := runSessionStatement(t, manager, "profile-1", path, id, false, `SELECT count(*) FROM items`); err != nil {
		t.Fatal(err)
	}
	if got := countItems(t, path); got != 0 {
		t.Fatalf("row visible before commit, count=%d", got)
	}
	if err := manager.Commit(ctx, "profile-1", id); err != nil {
		t.Fatal(err)
	}
	if got := countItems(t, path); got != 1 {
		t.Fatalf("row count after commit = %d, want 1", got)
	}

	if err := runSessionStatement(t, manager, "profile-1", path, id, false, `INSERT INTO items(name) VALUES ('roll me back')`); err != nil {
		t.Fatal(err)
	}
	if err := manager.Rollback(ctx, "profile-1", id); err != nil {
		t.Fatal(err)
	}
	if got := countItems(t, path); got != 1 {
		t.Fatalf("row count after rollback = %d, want 1", got)
	}
}

func TestManagerTransactionOutlivesIndividualQueryRequestContext(t *testing.T) {
	ctx := context.Background()
	path, db := openTestDB(t)
	manager := NewManager(time.Hour)
	id, err := manager.Open(ctx, "profile-1", path, db, false)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close("profile-1", id)

	requestCtx, cancelRequest := context.WithCancel(ctx)
	lease, err := manager.Query(requestCtx, "profile-1", path, id, false,
		`INSERT INTO items(name) VALUES ('survives request')`)
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.Rows.Err(); err != nil {
		t.Fatal(err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	cancelRequest()

	if err := manager.Commit(ctx, "profile-1", id); err != nil {
		t.Fatalf("commit after request context cancellation: %v", err)
	}
	if got := countItems(t, path); got != 1 {
		t.Fatalf("row count after commit = %d, want 1", got)
	}
}

func TestManagerSQLRollbackStartsANewManualTransactionOnNextStatement(t *testing.T) {
	ctx := context.Background()
	path, db := openTestDB(t)
	manager := NewManager(0)
	id, err := manager.Open(ctx, "profile-1", path, db, false)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close("profile-1", id)
	for _, query := range []string{
		`INSERT INTO items(name) VALUES ('first')`,
		`ROLLBACK`,
		`INSERT INTO items(name) VALUES ('second')`,
	} {
		if err := runSessionStatement(t, manager, "profile-1", path, id, false, query); err != nil {
			t.Fatal(err)
		}
	}
	if got := countItems(t, path); got != 0 {
		t.Fatalf("next manual statement was implicitly committed after SQL ROLLBACK: count=%d", got)
	}
	if err := manager.Commit(ctx, "profile-1", id); err != nil {
		t.Fatal(err)
	}
	if got := countItems(t, path); got != 1 {
		t.Fatalf("count after commit=%d, want 1", got)
	}
}

func TestManagerBindsOwnerDatabaseAndReadOnlyMode(t *testing.T) {
	ctx := context.Background()
	path, _ := openTestDB(t)
	db := openReadOnlyTestDB(t, path)
	manager := NewManager(time.Hour)
	id, err := manager.Open(ctx, "profile-1", path, db, true)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close("profile-1", id)

	if err := runSessionStatement(t, manager, "profile-2", path, id, true, `SELECT 1`); err == nil {
		t.Fatal("expected a session owner mismatch")
	}
	if err := runSessionStatement(t, manager, "profile-1", path+"-other", id, true, `SELECT 1`); err == nil {
		t.Fatal("expected a database context mismatch")
	}
	if err := runSessionStatement(t, manager, "profile-1", path, id, false, `SELECT 1`); err == nil {
		t.Fatal("expected a write-mode mismatch")
	}
	if err := runSessionStatement(t, manager, "profile-1", path, id, true, `INSERT INTO items(name) VALUES ('blocked')`); err == nil {
		t.Fatal("expected a read-only transaction to reject writes")
	}
}

func TestManagerCloseAndIdleExpirationRollbackActiveTransaction(t *testing.T) {
	for _, expire := range []bool{false, true} {
		t.Run(map[bool]string{false: "close", true: "idle expiration"}[expire], func(t *testing.T) {
			path, db := openTestDB(t)
			manager := NewManager(15 * time.Minute)
			id, err := manager.Open(context.Background(), "profile-1", path, db, false)
			if err != nil {
				t.Fatal(err)
			}
			if err := runSessionStatement(t, manager, "profile-1", path, id, false, `INSERT INTO items(name) VALUES ('uncommitted')`); err != nil {
				t.Fatal(err)
			}
			if expire {
				manager.ExpireIdle(time.Now().Add(time.Hour))
			} else if err := manager.Close("profile-1", id); err != nil {
				t.Fatal(err)
			}
			if got := countItems(t, path); got != 0 {
				t.Fatalf("row count after %s = %d, want 0", map[bool]string{false: "close", true: "expiration"}[expire], got)
			}
		})
	}
}

func TestAutoSessionKeepsConnectionAndHonorsSQLBoundaries(t *testing.T) {
	ctx := context.Background()
	path, db := openTestDB(t)
	m := NewManager(0)
	initializations := 0
	id, err := m.Open(ctx, "p", path, db, false, Options{AutoCommit: true,
		Initialize: func(ctx context.Context, conn *sql.Conn) (int64, error) {
			initializations++
			_, err := conn.ExecContext(ctx, `CREATE TEMP TABLE session_marker (value INT)`)
			return 42, err
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close("p", id)
	run := func(q string) {
		t.Helper()
		if err := runSessionStatement(t, m, "p", path, id, false, q); err != nil {
			t.Fatal(err)
		}
	}
	state := func(want string) {
		t.Helper()
		got, err := m.State("p", id)
		if err != nil || got != want {
			t.Fatalf("state=%s err=%v, want %s", got, err, want)
		}
	}
	run(`INSERT INTO items(name) VALUES ('auto')`)
	if countItems(t, path) != 1 {
		t.Fatal("plain Auto DML did not commit")
	}
	state("idle")
	run(`BEGIN`)
	run(`INSERT INTO session_marker VALUES (1)`)
	run(`INSERT INTO items(name) VALUES ('rollback')`)
	state("active")
	if countItems(t, path) != 1 {
		t.Fatal("explicit transaction was committed early")
	}
	run(`SAVEPOINT checkpoint`)
	run(`INSERT INTO items(name) VALUES ('savepoint')`)
	run(`ROLLBACK TO SAVEPOINT checkpoint`)
	state("active")
	run(`ROLLBACK`)
	state("idle")
	if countItems(t, path) != 1 {
		t.Fatal("SQL rollback failed")
	}
	run(`BEGIN`)
	run(`INSERT INTO items(name) VALUES ('commit')`)
	if err := m.Commit(ctx, "p", id); err != nil {
		t.Fatal(err)
	}
	if countItems(t, path) != 2 {
		t.Fatal("toolbar commit did not finish SQL transaction")
	}
	if err := m.SetAutoCommit("p", id, false); err != nil {
		t.Fatal(err)
	}
	run(`INSERT INTO session_marker VALUES (2)`)
	if initializations != 1 {
		t.Fatalf("session initialized %d times", initializations)
	}
	if err := m.SetAutoCommit("p", id, true); err == nil {
		t.Fatal("mode changed with pending work")
	}
	if err := m.Rollback(ctx, "p", id); err != nil {
		t.Fatal(err)
	}
}

func TestAutoSessionCloseAndExpirationRollbackAndRejectStaleReferences(t *testing.T) {
	for _, expire := range []bool{false, true} {
		t.Run(map[bool]string{false: "close", true: "expire"}[expire], func(t *testing.T) {
			path, db := openTestDB(t)
			m := NewManager(time.Hour)
			defer m.Shutdown()
			id, err := m.Open(context.Background(), "p", path, db, false, Options{AutoCommit: true})
			if err != nil {
				t.Fatal(err)
			}
			stale, _ := m.lookup(id)
			for _, q := range []string{`BEGIN`, `INSERT INTO items(name) VALUES ('pending')`} {
				if err := runSessionStatement(t, m, "p", path, id, false, q); err != nil {
					t.Fatal(err)
				}
			}
			if expire {
				m.ExpireIdle(time.Now().Add(2 * time.Hour))
			} else if err := m.Close("p", id); err != nil {
				t.Fatal(err)
			}
			if countItems(t, path) != 0 {
				t.Fatal("session close committed work")
			}
			if stale.validate("p", path, false) != ErrClosed {
				t.Fatal("queued operation could reuse closed session")
			}
			if _, err := m.Begin(context.Background(), "p", path, id, false); err != ErrNotFound {
				t.Fatalf("stale session reopened: %v", err)
			}
			if err := m.Close("p", id); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestSQLiteSavepointReleaseDoesNotLeakManualWrites(t *testing.T) {
	for _, auto := range []bool{false, true} {
		t.Run(map[bool]string{false: "manual", true: "auto"}[auto], func(t *testing.T) {
			path, db := openTestDB(t)
			m := NewManager(0)
			id, err := m.Open(context.Background(), "p", path, db, false, Options{AutoCommit: auto, Dialect: "sqlite"})
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close("p", id)
			for _, q := range []string{`SAVEPOINT "outer checkpoint"`, `INSERT INTO items(name) VALUES ('first')`, `RELEASE SAVEPOINT "outer checkpoint"`, `INSERT INTO items(name) VALUES ('second')`} {
				if err := runSessionStatement(t, m, "p", path, id, false, q); err != nil {
					t.Fatal(err)
				}
			}
			wantState, wantCount := "active", 0
			if auto {
				wantState, wantCount = "idle", 2
			}
			state, err := m.State("p", id)
			if state != wantState || err != nil || countItems(t, path) != wantCount {
				t.Fatalf("state=%s err=%v count=%d", state, err, countItems(t, path))
			}
		})
	}
}
