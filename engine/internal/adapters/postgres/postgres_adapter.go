package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"net"
	"strings"

	pqDriver "github.com/lib/pq"
	"github.com/smlee/database-local-engine/engine/internal/adapters"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type PostgreSQLConnector struct{}

func NewPostgreSQLConnector() *PostgreSQLConnector {
	return &PostgreSQLConnector{}
}

func (c *PostgreSQLConnector) TestConnection(ctx context.Context, p domain.ConnectionProfile, password string) error {
	db, err := c.connect(p, password, p.Database)
	if err != nil {
		return err
	}
	defer db.Close()
	return c.normalizeError(db.PingContext(ctx))
}

func (c *PostgreSQLConnector) connect(p domain.ConnectionProfile, password string, database string) (*sql.DB, error) {
	// libpq native sslmode values. "require" forces encryption, "prefer" uses
	// TLS opportunistically with plaintext fallback. Certificate verification
	// (verify-ca/verify-full) needs a configurable CA bundle, which is an
	// explicitly deferred "advanced certificate profile" (see product-brief).
	sslMode := "disable"
	switch p.TLSMode {
	case "require":
		sslMode = "require"
	case "prefer":
		sslMode = "prefer"
	}

	// In a libpq single-quoted value, backslash and single-quote are the only
	// characters that need escaping (and backslash must be escaped first).
	// Spaces inside the quotes are literal and must NOT be escaped.
	escapedPassword := strings.ReplaceAll(password, "\\", "\\\\")
	escapedPassword = strings.ReplaceAll(escapedPassword, "'", "\\'")

	dsn := fmt.Sprintf("host=%s port=%d user=%s password='%s' dbname=%s sslmode=%s connect_timeout=5",
		p.Host, p.Port, p.Username, escapedPassword, database, sslMode)

	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, c.normalizeError(err)
	}
	return db, nil
}

func (c *PostgreSQLConnector) ListDatabases(ctx context.Context, p domain.ConnectionProfile, password string) ([]ports.DatabaseInfo, error) {
	db, err := c.connect(p, password, "postgres")
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, "SELECT datname FROM pg_database WHERE datistemplate = false")
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

func (c *PostgreSQLConnector) ListTables(ctx context.Context, p domain.ConnectionProfile, password string, database string) ([]ports.TableInfo, error) {
	db, err := c.connect(p, password, database)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, `
		SELECT table_name
		FROM information_schema.tables
		WHERE table_catalog = $1 AND table_schema = 'public'
	`, database)
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

func (c *PostgreSQLConnector) DescribeTable(ctx context.Context, p domain.ConnectionProfile, password string, database string, table string) (ports.TableDescription, error) {
	db, err := c.connect(p, password, database)
	if err != nil {
		return ports.TableDescription{}, err
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, `
		SELECT column_name, data_type, is_nullable
		FROM information_schema.columns
		WHERE table_catalog = $1 AND table_schema = 'public' AND table_name = $2
		ORDER BY ordinal_position
	`, database, table)
	if err != nil {
		return ports.TableDescription{}, c.normalizeError(err)
	}
	defer rows.Close()

	pkRows, err := db.QueryContext(ctx, `
		SELECT kcu.column_name
		FROM information_schema.table_constraints tc 
		JOIN information_schema.key_column_usage kcu
		  ON tc.constraint_name = kcu.constraint_name
		  AND tc.table_schema = kcu.table_schema
		WHERE tc.constraint_type = 'PRIMARY KEY'
		  AND tc.table_catalog = $1
		  AND tc.table_schema = 'public'
		  AND tc.table_name = $2
	`, database, table)
	pkColumns := make(map[string]bool)
	if err == nil {
		defer pkRows.Close()
		for pkRows.Next() {
			var pkCol string
			if err := pkRows.Scan(&pkCol); err == nil {
				pkColumns[pkCol] = true
			}
		}
	}

	var columns []ports.ColumnInfo
	for rows.Next() {
		var colName, dataType, isNullable string
		if err := rows.Scan(&colName, &dataType, &isNullable); err != nil {
			return ports.TableDescription{}, c.normalizeError(err)
		}

		columns = append(columns, ports.ColumnInfo{
			Name:       colName,
			Type:       dataType,
			Nullable:   isNullable == "YES",
			PrimaryKey: pkColumns[colName],
		})
	}

	return ports.TableDescription{Columns: columns}, nil
}

func (c *PostgreSQLConnector) ListColumns(ctx context.Context, p domain.ConnectionProfile, password string, database string) ([]ports.ColumnRef, error) {
	db, err := c.connect(p, password, database)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.QueryContext(ctx, `
		SELECT table_name, column_name, data_type
		FROM information_schema.columns
		WHERE table_schema = 'public'
		ORDER BY table_name, ordinal_position
	`)
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

func (c *PostgreSQLConnector) GetTableDDL(ctx context.Context, p domain.ConnectionProfile, password string, database string, table string) (string, error) {
	db, err := c.connect(p, password, database)
	if err != nil {
		return "", err
	}
	defer db.Close()

	const schema = "public"
	qualified := schema + "." + table

	colRows, err := db.QueryContext(ctx, `
		SELECT a.attname,
		       format_type(a.atttypid, a.atttypmod) AS type,
		       a.attnotnull,
		       COALESCE(pg_get_expr(d.adbin, d.adrelid), '') AS default_expr
		FROM pg_attribute a
		LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
		WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY a.attnum
	`, qualified)
	if err != nil {
		return "", c.normalizeError(err)
	}
	defer colRows.Close()

	var cols []pgColumn
	for colRows.Next() {
		var col pgColumn
		if err := colRows.Scan(&col.Name, &col.Type, &col.NotNull, &col.Default); err != nil {
			return "", c.normalizeError(err)
		}
		cols = append(cols, col)
	}
	if len(cols) == 0 {
		return "", fmt.Errorf("table not found: %s", qualified)
	}

	var pk []string
	pkRows, err := db.QueryContext(ctx, `
		SELECT a.attname
		FROM pg_index i
		JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey::int2[])
		WHERE i.indrelid = $1::regclass AND i.indisprimary
		ORDER BY array_position(i.indkey::int2[], a.attnum)
	`, qualified)
	if err == nil {
		defer pkRows.Close()
		for pkRows.Next() {
			var name string
			if err := pkRows.Scan(&name); err == nil {
				pk = append(pk, name)
			}
		}
	}

	return buildPostgresCreateTable(schema, table, cols, pk), nil
}

func (c *PostgreSQLConnector) ExecuteQueryStream(
	ctx context.Context,
	p domain.ConnectionProfile,
	password string,
	query string,
	readOnly bool,
	onSessionStart func(sessionID int64),
	onHeader func(columns []string) error,
	onRow func(row []any) error,
) (int64, error) {
	db, err := c.connect(p, password, p.Database)
	if err != nil {
		return 0, err
	}
	defer db.Close()

	conn, err := db.Conn(ctx)
	if err != nil {
		return 0, c.normalizeError(err)
	}
	defer conn.Close()

	// 1. Get process PID for cancellation
	var pid int64
	err = conn.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&pid)
	if err != nil {
		return 0, c.normalizeError(err)
	}

	if onSessionStart != nil {
		onSessionStart(pid)
	}

	// Defense-in-depth (security.md): force the session read-only so a write
	// the app classifier misjudges still cannot modify data.
	if readOnly {
		if _, err := conn.ExecContext(ctx, "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY"); err != nil {
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

func (c *PostgreSQLConnector) CancelSession(ctx context.Context, p domain.ConnectionProfile, password string, sessionID int64) error {
	db, err := c.connect(p, password, "postgres")
	if err != nil {
		return err
	}
	defer db.Close()

	_, err = db.ExecContext(ctx, "SELECT pg_cancel_backend($1)", sessionID)
	return c.normalizeError(err)
}



func (c *PostgreSQLConnector) normalizeError(err error) error {
	if err == nil {
		return nil
	}

	errStr := err.Error()

	if pqErr, ok := err.(*pqDriver.Error); ok {
		switch pqErr.Code {
		case "28P01", "28000":
			return adapters.ErrAuthFailed
		}
	}

	if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
		return adapters.ErrTimeout
	}

	if strings.Contains(errStr, "connection refused") || strings.Contains(errStr, "no such host") || strings.Contains(errStr, "i/o timeout") || strings.Contains(errStr, "timeout expired") {
		return adapters.ErrNetworkUnreachable
	}

	if strings.Contains(errStr, "password authentication failed") {
		return adapters.ErrAuthFailed
	}

	if strings.Contains(errStr, "SSL") || strings.Contains(errStr, "tls") || strings.Contains(errStr, "certificate") {
		return adapters.ErrTLSFailed
	}

	return err
}
type PostgreSQLAdapter = PostgreSQLConnector
