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
