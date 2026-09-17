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
	id, err := manager.Open(ctx, "profile-1", path, db, false, true)
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
	id, err := manager.Open(ctx, "profile-1", path, db, false, true)
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

func TestManagerBindsOwnerDatabaseAndReadOnlyMode(t *testing.T) {
	ctx := context.Background()
	path, _ := openTestDB(t)
	db := openReadOnlyTestDB(t, path)
	manager := NewManager(time.Hour)
	id, err := manager.Open(ctx, "profile-1", path, db, true, true)
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
			id, err := manager.Open(context.Background(), "profile-1", path, db, false, true)
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
