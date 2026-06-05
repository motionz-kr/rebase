package sqlserver

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strings"

	// Register the SQL Server driver under the name "sqlserver".
	_ "github.com/microsoft/go-mssqldb"
	"github.com/smlee/database-local-engine/engine/internal/adapters"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// SQLServerConnector talks to Microsoft SQL Server (and T-SQL-compatible
// servers such as Azure SQL Edge) via github.com/microsoft/go-mssqldb.
type SQLServerConnector struct{}

func NewSQLServerConnector() *SQLServerConnector {
	return &SQLServerConnector{}
}

// dsn builds a sqlserver:// URL DSN. Passwords may contain reserved characters,
// so userinfo is URL-encoded via net/url. TLSMode maps to the driver's encrypt
// option: require/prefer -> encrypt with a relaxed cert check (verify-ca/full is
// a deferred advanced-certificate profile); otherwise encryption is disabled.
func (c *SQLServerConnector) dsn(p domain.ConnectionProfile, password, database string) string {
	q := url.Values{}
	if database == "" {
		database = p.Database
	}
	if database != "" {
		q.Set("database", database)
	}
	switch p.TLSMode {
	case "require", "prefer":
		q.Set("encrypt", "true")
		q.Set("trustServerCertificate", "true")
	default: // "none", ""
		q.Set("encrypt", "disable")
	}
	q.Set("connection timeout", "5")

	u := url.URL{
		Scheme:   "sqlserver",
		User:     url.UserPassword(p.Username, password),
		Host:     fmt.Sprintf("%s:%d", p.Host, p.Port),
		RawQuery: q.Encode(),
	}
	return u.String()
}

func (c *SQLServerConnector) connect(p domain.ConnectionProfile, password, database string) (*sql.DB, error) {
	db, err := sql.Open("sqlserver", c.dsn(p, password, database))
	if err != nil {
		return nil, c.normalizeError(err)
	}
	return db, nil
}

func (c *SQLServerConnector) TestConnection(ctx context.Context, p domain.ConnectionProfile, password string) error {
	db, err := c.connect(p, password, p.Database)
	if err != nil {
		return err
	}
	defer db.Close()
	return c.normalizeError(db.PingContext(ctx))
}

// ListDatabases returns user databases (database_id > 4 skips the system DBs
// master/tempdb/model/msdb).
func (c *SQLServerConnector) ListDatabases(ctx context.Context, p domain.ConnectionProfile, password string) ([]ports.DatabaseInfo, error) {
	db, err := c.connect(p, password, p.Database)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, "SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name")
	if err != nil {
		return nil, c.normalizeError(err)
	}
	defer rows.Close()

	var list []ports.DatabaseInfo
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, c.normalizeError(err)
		}
		list = append(list, ports.DatabaseInfo{Name: name})
	}
	return list, c.normalizeError(rows.Err())
}

func (c *SQLServerConnector) ListTables(ctx context.Context, p domain.ConnectionProfile, password string, database string) ([]ports.TableInfo, error) {
	db, err := c.connect(p, password, database)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME")
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

func (c *SQLServerConnector) ListViews(ctx context.Context, p domain.ConnectionProfile, password string, database string) ([]ports.TableInfo, error) {
	db, err := c.connect(p, password, database)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.VIEWS ORDER BY TABLE_NAME")
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

// GetViewDDL returns the stored definition of a view from sys.sql_modules. The
// view name is bound as a positional parameter (@p1) supported by go-mssqldb.
func (c *SQLServerConnector) GetViewDDL(ctx context.Context, p domain.ConnectionProfile, password string, database string, view string) (string, error) {
	db, err := c.connect(p, password, database)
	if err != nil {
		return "", err
	}
	defer db.Close()

	var def sql.NullString
	err = db.QueryRowContext(ctx,
		"SELECT m.definition FROM sys.sql_modules m JOIN sys.objects o ON o.object_id = m.object_id WHERE o.name = @p1",
		view,
	).Scan(&def)
	if err != nil {
		return "", c.normalizeError(err)
	}
	return def.String, nil
}

// normalizeError maps driver/server errors to friendly sentinels.
func (c *SQLServerConnector) normalizeError(err error) error {
	if err == nil {
		return nil
	}
	errStr := err.Error()
	switch {
	case strings.Contains(errStr, "Login failed"):
		return adapters.ErrAuthFailed
	case strings.Contains(errStr, "Cannot open database"):
		return fmt.Errorf("cannot open database: %w", err)
	case strings.Contains(errStr, "connection refused") || strings.Contains(errStr, "no such host") || strings.Contains(errStr, "i/o timeout"):
		return adapters.ErrNetworkUnreachable
	default:
		return err
	}
}
