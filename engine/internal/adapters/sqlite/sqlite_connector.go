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
