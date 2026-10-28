package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"path/filepath"
)

// OpenMetadataDatabase configures only the engine-owned metadata store. User
// SQLite connections and authored SQL retain their own transaction settings.
func OpenMetadataDatabase(ctx context.Context, path string) (*sql.DB, error) {
	values := url.Values{}
	values.Add("_pragma", "busy_timeout(5000)")
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve metadata path: %w", err)
	}
	dsn := (&url.URL{Scheme: "file", Path: absolute, RawQuery: values.Encode()}).String()
	if path == ":memory:" {
		dsn = "file::memory:?" + values.Encode()
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open metadata database: %w", err)
	}
	// Metadata operations are short, and SQLite permits only one writer. Keep
	// each engine's writes serialized; other engines wait through busy_timeout.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	var mode string
	if err := db.QueryRowContext(ctx, "PRAGMA journal_mode=WAL").Scan(&mode); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("configure metadata journal: %w", err)
	}
	if mode != "wal" && !(path == ":memory:" && mode == "memory") {
		_ = db.Close()
		return nil, fmt.Errorf("unexpected metadata journal mode: %s", mode)
	}
	return db, nil
}
