package sqlite

import (
	"database/sql"
	"fmt"
)

type Migration struct {
	Version  int
	Name     string
	SQL      string
	Checksum string
}

type MigrationRunner struct {
	db *sql.DB
}

func NewMigrationRunner(db *sql.DB) *MigrationRunner {
	return &MigrationRunner{db: db}
}

func (r *MigrationRunner) Run(migrations []Migration) error {
	_, err := r.db.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			checksum TEXT NOT NULL,
			applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
	`)
	if err != nil {
		return fmt.Errorf("failed to create schema_migrations table: %w", err)
	}

	applied := make(map[int]string)
	rows, err := r.db.Query("SELECT version, checksum FROM schema_migrations")
	if err != nil {
		return fmt.Errorf("failed to fetch schema_migrations: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var v int
		var cs string
		if err := rows.Scan(&v, &cs); err != nil {
			return fmt.Errorf("failed to scan migration row: %w", err)
		}
		applied[v] = cs
	}

	// Each migration runs in its own transaction so that already-applied
	// migrations remain durable when a later one fails (ADR-0005). A single
	// shared transaction would roll back successful earlier migrations too.
	for _, m := range migrations {
		existingChecksum, exists := applied[m.Version]
		if exists {
			if existingChecksum != m.Checksum {
				// existingChecksum is the recorded source of truth ("expected");
				// m.Checksum is what the (possibly modified) migration now hashes to.
				return fmt.Errorf("checksum mismatch for migration version %d: expected %s, got %s", m.Version, existingChecksum, m.Checksum)
			}
			continue
		}

		if err := r.applyOne(m); err != nil {
			return err
		}
	}

	return nil
}

func (r *MigrationRunner) applyOne(m Migration) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("failed to start transaction for migration version %d: %w", m.Version, err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(m.SQL); err != nil {
		return fmt.Errorf("failed to apply migration version %d (%s): %w", m.Version, m.Name, err)
	}

	if _, err := tx.Exec("INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)", m.Version, m.Name, m.Checksum); err != nil {
		return fmt.Errorf("failed to record migration version %d: %w", m.Version, err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit migration version %d: %w", m.Version, err)
	}

	return nil
}
