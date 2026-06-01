package sqlite

import (
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

func TestMigrationRunner(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}
	defer db.Close()

	migrations := []Migration{
		{
			Version:  1,
			Name:     "create_profiles_table",
			SQL:      `CREATE TABLE connection_profiles (id TEXT PRIMARY KEY, name TEXT);`,
			Checksum: "hash-v1",
		},
		{
			Version:  2,
			Name:     "add_driver_column",
			SQL:      `ALTER TABLE connection_profiles ADD COLUMN driver TEXT;`,
			Checksum: "hash-v2",
		},
	}

	runner := NewMigrationRunner(db)

	t.Run("fresh install", func(t *testing.T) {
		err := runner.Run(migrations)
		if err != nil {
			t.Fatalf("migration failed: %v", err)
		}

		var count int
		err = db.QueryRow("SELECT COUNT(*) FROM schema_migrations").Scan(&count)
		if err != nil {
			t.Fatalf("failed to query schema_migrations: %v", err)
		}
		if count != 2 {
			t.Errorf("expected 2 migrations applied, got %d", count)
		}
	})

	t.Run("idempotency", func(t *testing.T) {
		err := runner.Run(migrations)
		if err != nil {
			t.Fatalf("re-running migrations failed: %v", err)
		}
	})

	t.Run("checksum mismatch", func(t *testing.T) {
		modifiedMigrations := []Migration{
			{
				Version:  1,
				Name:     "create_profiles_table",
				SQL:      `CREATE TABLE connection_profiles (id TEXT PRIMARY KEY, name TEXT);`,
				Checksum: "hash-v1-modified",
			},
		}
		err := runner.Run(modifiedMigrations)
		if err == nil {
			t.Error("expected error due to checksum mismatch, got nil")
		}
	})

	t.Run("rollback on failure", func(t *testing.T) {
		failedMigrations := []Migration{
			{
				Version:  1,
				Name:     "create_profiles_table",
				SQL:      `CREATE TABLE connection_profiles (id TEXT PRIMARY KEY, name TEXT);`,
				Checksum: "hash-v1",
			},
			{
				Version:  2,
				Name:     "add_driver_column",
				SQL:      `ALTER TABLE connection_profiles ADD COLUMN driver TEXT;`,
				Checksum: "hash-v2",
			},
			{
				Version:  3,
				Name:     "invalid_sql_migration",
				SQL:      `CREATE TABLE invalid_table (id TEXT PRIMARY KEY,);`,
				Checksum: "hash-v3",
			},
		}

		err := runner.Run(failedMigrations)
		if err == nil {
			t.Error("expected error due to invalid SQL syntax, got nil")
		}

		var exists bool
		err = db.QueryRow("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = 3)").Scan(&exists)
		if err != nil {
			t.Fatalf("failed to query schema_migrations: %v", err)
		}
		if exists {
			t.Error("expected version 3 to be rolled back and not exist")
		}
	})

	// Regression: when a later migration fails on a FRESH database, the earlier
	// migrations applied in the same run must remain durable (one transaction
	// per migration, per ADR-0005). A single shared transaction would roll back
	// versions 1 and 2 as well, losing successful work.
	t.Run("partial progress durability on first run", func(t *testing.T) {
		freshDB, err := sql.Open("sqlite", ":memory:")
		if err != nil {
			t.Fatalf("failed to open database: %v", err)
		}
		defer freshDB.Close()

		failingSet := []Migration{
			{Version: 1, Name: "m1", SQL: `CREATE TABLE a (id TEXT PRIMARY KEY);`, Checksum: "h1"},
			{Version: 2, Name: "m2", SQL: `CREATE TABLE b (id TEXT PRIMARY KEY);`, Checksum: "h2"},
			{Version: 3, Name: "m3_bad", SQL: `CREATE TABLE c (id TEXT PRIMARY KEY,);`, Checksum: "h3"},
		}

		if err := NewMigrationRunner(freshDB).Run(failingSet); err == nil {
			t.Fatal("expected error from invalid migration 3, got nil")
		}

		var applied int
		if err := freshDB.QueryRow("SELECT COUNT(*) FROM schema_migrations").Scan(&applied); err != nil {
			t.Fatalf("failed to count schema_migrations: %v", err)
		}
		if applied != 2 {
			t.Errorf("expected migrations 1 and 2 to survive a later failure, got %d applied", applied)
		}

		// The tables created by the successful migrations must still exist.
		for _, table := range []string{"a", "b"} {
			var name string
			err := freshDB.QueryRow("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", table).Scan(&name)
			if err != nil {
				t.Errorf("expected table %q to persist after partial migration failure: %v", table, err)
			}
		}
	})
}
