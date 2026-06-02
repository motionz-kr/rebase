package mysql

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"strings"
	"time"

	mysqlDriver "github.com/go-sql-driver/mysql"
	"github.com/smlee/database-local-engine/engine/internal/adapters"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type MySQLConnector struct{}

func NewMySQLConnector() *MySQLConnector {
	return &MySQLConnector{}
}

func (c *MySQLConnector) TestConnection(ctx context.Context, p domain.ConnectionProfile, password string) error {
	db, err := c.connect(p, password, p.Database)
	if err != nil {
		return err
	}
	defer db.Close()
	return c.normalizeError(db.PingContext(ctx))
}

func (c *MySQLConnector) connect(p domain.ConnectionProfile, password string, database string) (*sql.DB, error) {
	cfg := mysqlDriver.NewConfig()
	cfg.User = p.Username
	cfg.Passwd = password
	cfg.Net = "tcp"
	cfg.Addr = fmt.Sprintf("%s:%d", p.Host, p.Port)
	cfg.DBName = database
	cfg.Timeout = 5 * time.Second
	cfg.ReadTimeout = 5 * time.Second
	cfg.WriteTimeout = 5 * time.Second
	cfg.AllowNativePasswords = true

	// Use the driver's built-in TLS modes so we don't mutate the driver's
	// global TLS-config registry on every connect (which is racy). "skip-verify"
	// forces encryption; "preferred" uses TLS opportunistically with plaintext
	// fallback. Certificate verification needs a configurable CA bundle, which
	// is an explicitly deferred "advanced certificate profile" (see product-brief).
	switch p.TLSMode {
	case "require":
		cfg.TLSConfig = "skip-verify"
	case "prefer":
		cfg.TLSConfig = "preferred"
	}

	// go-sql-driver v1.10 auto-requests the server's public key for
	// caching_sha2_password over a non-TLS connection (MySQL 8 default), so no
	// allowPublicKeyRetrieval flag is needed — and that flag is not a recognized
	// DSN param in this version, so appending it would be sent to the server as
	// an unknown system variable and rejected (Error 1193) after auth.
	db, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		return nil, c.normalizeError(err)
	}
	return db, nil
}

func (c *MySQLConnector) ListDatabases(ctx context.Context, p domain.ConnectionProfile, password string) ([]ports.DatabaseInfo, error) {
	db, err := c.connect(p, password, "")
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, "SHOW DATABASES")
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
	return list, nil
}

func (c *MySQLConnector) ListTables(ctx context.Context, p domain.ConnectionProfile, password string, database string) ([]ports.TableInfo, error) {
	db, err := c.connect(p, password, database)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, "SELECT table_name FROM information_schema.tables WHERE table_schema = ?", database)
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
	return list, nil
}

func (c *MySQLConnector) DescribeTable(ctx context.Context, p domain.ConnectionProfile, password string, database string, table string) (ports.TableDescription, error) {
	db, err := c.connect(p, password, database)
	if err != nil {
		return ports.TableDescription{}, err
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, `
		SELECT column_name, data_type, is_nullable, column_key 
		FROM information_schema.columns 
		WHERE table_schema = ? AND table_name = ?
		ORDER BY ordinal_position
	`, database, table)
	if err != nil {
		return ports.TableDescription{}, c.normalizeError(err)
	}
	defer rows.Close()

	var columns []ports.ColumnInfo
	for rows.Next() {
		var colName, dataType, isNullable, colKey string
		if err := rows.Scan(&colName, &dataType, &isNullable, &colKey); err != nil {
			return ports.TableDescription{}, c.normalizeError(err)
		}

		columns = append(columns, ports.ColumnInfo{
			Name:       colName,
			Type:       dataType,
			Nullable:   isNullable == "YES",
			PrimaryKey: colKey == "PRI",
		})
	}

	return ports.TableDescription{Columns: columns}, nil
}

func (c *MySQLConnector) ListColumns(ctx context.Context, p domain.ConnectionProfile, password string, database string) ([]ports.ColumnRef, error) {
	db, err := c.connect(p, password, database)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, `
		SELECT table_name, column_name, data_type
		FROM information_schema.columns
		WHERE table_schema = ?
		ORDER BY table_name, ordinal_position
	`, database)
	if err != nil {
		return nil, c.normalizeError(err)
	}
	defer rows.Close()

	var out []ports.ColumnRef
	for rows.Next() {
		var ref ports.ColumnRef
		if err := rows.Scan(&ref.Table, &ref.Column, &ref.Type); err != nil {
			return nil, c.normalizeError(err)
		}
		out = append(out, ref)
	}
	return out, nil
}

func (c *MySQLConnector) GetTableDDL(ctx context.Context, p domain.ConnectionProfile, password string, database string, table string) (string, error) {
	db, err := c.connect(p, password, database)
	if err != nil {
		return "", err
	}
	defer db.Close()

	// Identifiers can't be parameterized in SHOW CREATE TABLE; quote with
	// backticks and escape any embedded backtick to prevent injection.
	q := fmt.Sprintf("SHOW CREATE TABLE `%s`.`%s`", escapeMySQLIdent(database), escapeMySQLIdent(table))
	var name, ddl string
	if err := db.QueryRowContext(ctx, q).Scan(&name, &ddl); err != nil {
		return "", c.normalizeError(err)
	}
	return ddl, nil
}

func escapeMySQLIdent(s string) string {
	return strings.ReplaceAll(s, "`", "``")
}

func (c *MySQLConnector) connectForQuery(p domain.ConnectionProfile, password string) (*sql.DB, error) {
	cfg := mysqlDriver.NewConfig()
	cfg.User = p.Username
	cfg.Passwd = password
	cfg.Net = "tcp"
	cfg.Addr = fmt.Sprintf("%s:%d", p.Host, p.Port)
	cfg.DBName = p.Database
	cfg.Timeout = 5 * time.Second
	cfg.ReadTimeout = 0  // Unlimited for queries
	cfg.WriteTimeout = 0 // Unlimited for queries
	cfg.AllowNativePasswords = true

	// Use the driver's built-in TLS modes so we don't mutate the driver's
	// global TLS-config registry on every connect (which is racy). "skip-verify"
	// forces encryption; "preferred" uses TLS opportunistically with plaintext
	// fallback. Certificate verification needs a configurable CA bundle, which
	// is an explicitly deferred "advanced certificate profile" (see product-brief).
	switch p.TLSMode {
	case "require":
		cfg.TLSConfig = "skip-verify"
	case "prefer":
		cfg.TLSConfig = "preferred"
	}

	// go-sql-driver v1.10 auto-requests the server's public key for
	// caching_sha2_password over a non-TLS connection (MySQL 8 default), so no
	// allowPublicKeyRetrieval flag is needed — and that flag is not a recognized
	// DSN param in this version, so appending it would be sent to the server as
	// an unknown system variable and rejected (Error 1193) after auth.
	db, err := sql.Open("mysql", cfg.FormatDSN())
	if err != nil {
		return nil, c.normalizeError(err)
	}
	return db, nil
}

func (c *MySQLConnector) ExecuteQueryStream(
	ctx context.Context,
	p domain.ConnectionProfile,
	password string,
	query string,
	readOnly bool,
	onSessionStart func(sessionID int64),
	onHeader func(columns []string) error,
	onRow func(row []any) error,
) (int64, error) {
	db, err := c.connectForQuery(p, password)
	if err != nil {
		return 0, err
	}
	defer db.Close()

	conn, err := db.Conn(ctx)
	if err != nil {
		return 0, c.normalizeError(err)
	}
	defer conn.Close()

	// 1. Get Connection ID for cancellation mapping
	var threadID int64
	err = conn.QueryRowContext(ctx, "SELECT CONNECTION_ID()").Scan(&threadID)
	if err != nil {
		return 0, c.normalizeError(err)
	}

	if onSessionStart != nil {
		onSessionStart(threadID)
	}

	// Defense-in-depth (security.md): enforce read-only at the DB session so a
	// statement the app classifier misjudges still cannot write. With autocommit
	// each statement is its own transaction, so this applies to the user query.
	if readOnly {
		if _, err := conn.ExecContext(ctx, "SET SESSION TRANSACTION READ ONLY"); err != nil {
			return 0, c.normalizeError(err)
		}
	}

	// 2. Execute query
	rows, err := conn.QueryContext(ctx, query)
	if err != nil {
		return 0, c.normalizeError(err)
	}
	defer rows.Close()

	// 3. Process Header
	cols, err := rows.Columns()
	if err != nil {
		return 0, c.normalizeError(err)
	}
	if err := onHeader(cols); err != nil {
		return 0, err
	}

	// 4. Process Rows
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

func (c *MySQLConnector) CancelSession(ctx context.Context, p domain.ConnectionProfile, password string, sessionID int64) error {
	db, err := c.connect(p, password, "")
	if err != nil {
		return err
	}
	defer db.Close()

	_, err = db.ExecContext(ctx, fmt.Sprintf("KILL QUERY %d", sessionID))
	return c.normalizeError(err)
}



// ExecuteBatch runs all statements inside a single transaction. On the first
// failure it rolls back and returns the 0-based index of the failed statement;
// on success it commits and returns the total rows affected with failedIndex -1.
func (c *MySQLConnector) ExecuteBatch(ctx context.Context, p domain.ConnectionProfile, password string, statements []string) (int64, int, error) {
	db, err := c.connectForQuery(p, password)
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

func (c *MySQLConnector) normalizeError(err error) error {
	if err == nil {
		return nil
	}

	errStr := err.Error()

	if mysqlErr, ok := err.(*mysqlDriver.MySQLError); ok {
		switch mysqlErr.Number {
		case 1045:
			return adapters.ErrAuthFailed
		}
	}

	if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
		return adapters.ErrTimeout
	}

	if strings.Contains(errStr, "connection refused") || strings.Contains(errStr, "no such host") || strings.Contains(errStr, "i/o timeout") {
		return adapters.ErrNetworkUnreachable
	}

	if strings.Contains(errStr, "Access denied") {
		return adapters.ErrAuthFailed
	}

	if strings.Contains(errStr, "tls") || strings.Contains(errStr, "certificate") || strings.Contains(errStr, "ssl") {
		return adapters.ErrTLSFailed
	}

	return err
}
type MySQLAdapter = MySQLConnector
