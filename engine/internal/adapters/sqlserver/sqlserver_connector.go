package sqlserver

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"strconv"
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

// DescribeTable returns the column list (with PK flags) for a single table,
// ordered by ordinal position. The table name is bound positionally; it is
// referenced twice in the query so we pass it as @p1 and @p2.
func (c *SQLServerConnector) DescribeTable(ctx context.Context, p domain.ConnectionProfile, password string, database string, table string) (ports.TableDescription, error) {
	db, err := c.connect(p, password, database)
	if err != nil {
		return ports.TableDescription{}, err
	}
	defer db.Close()

	const q = `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE,
    CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS is_pk
  FROM INFORMATION_SCHEMA.COLUMNS c
  LEFT JOIN (
    SELECT ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
    JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
    WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_NAME = @p1
  ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME
  WHERE c.TABLE_NAME = @p2
  ORDER BY c.ORDINAL_POSITION`

	rows, err := db.QueryContext(ctx, q, table, table)
	if err != nil {
		return ports.TableDescription{}, c.normalizeError(err)
	}
	defer rows.Close()

	var desc ports.TableDescription
	for rows.Next() {
		var name, dataType, isNullable string
		var isPK int
		if err := rows.Scan(&name, &dataType, &isNullable, &isPK); err != nil {
			return ports.TableDescription{}, c.normalizeError(err)
		}
		desc.Columns = append(desc.Columns, ports.ColumnInfo{
			Name:       name,
			Type:       dataType,
			Nullable:   isNullable == "YES",
			PrimaryKey: isPK == 1,
		})
	}
	return desc, c.normalizeError(rows.Err())
}

// ListColumns returns every base-table column in the database as flat
// (table, column, type) refs for editor autocompletion.
func (c *SQLServerConnector) ListColumns(ctx context.Context, p domain.ConnectionProfile, password string, database string) ([]ports.ColumnRef, error) {
	db, err := c.connect(p, password, database)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	const q = `SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE
  FROM INFORMATION_SCHEMA.COLUMNS c
  JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'
  ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`

	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		return nil, c.normalizeError(err)
	}
	defer rows.Close()

	var list []ports.ColumnRef
	for rows.Next() {
		var tbl, col, typ string
		if err := rows.Scan(&tbl, &col, &typ); err != nil {
			return nil, c.normalizeError(err)
		}
		list = append(list, ports.ColumnRef{Table: tbl, Column: col, Type: typ})
	}
	return list, c.normalizeError(rows.Err())
}

// ListForeignKeys returns the foreign-key column bindings of a single table.
func (c *SQLServerConnector) ListForeignKeys(ctx context.Context, p domain.ConnectionProfile, password string, database string, table string) ([]ports.ForeignKey, error) {
	db, err := c.connect(p, password, database)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	const q = `SELECT cp.name AS from_col, rt.name AS ref_table, cr.name AS ref_col
  FROM sys.foreign_keys fk
  JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
  JOIN sys.tables t ON t.object_id = fk.parent_object_id
  JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
  JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
  JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id
  WHERE t.name = @p1`

	rows, err := db.QueryContext(ctx, q, table)
	if err != nil {
		return nil, c.normalizeError(err)
	}
	defer rows.Close()

	var list []ports.ForeignKey
	for rows.Next() {
		var col, refTable, refCol string
		if err := rows.Scan(&col, &refTable, &refCol); err != nil {
			return nil, c.normalizeError(err)
		}
		list = append(list, ports.ForeignKey{Column: col, RefTable: refTable, RefColumn: refCol})
	}
	return list, c.normalizeError(rows.Err())
}

// ListIndexes returns the table's indexes (one entry per index, columns in
// key order). Heap rows (i.type = 0) are excluded.
func (c *SQLServerConnector) ListIndexes(ctx context.Context, p domain.ConnectionProfile, password string, database string, table string) ([]ports.Index, error) {
	db, err := c.connect(p, password, database)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	const q = `SELECT i.name AS index_name, i.is_unique, i.is_primary_key, c.name AS col_name
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  JOIN sys.tables t ON t.object_id = i.object_id
  WHERE t.name = @p1 AND i.type <> 0
  ORDER BY i.name, ic.key_ordinal`

	rows, err := db.QueryContext(ctx, q, table)
	if err != nil {
		return nil, c.normalizeError(err)
	}
	defer rows.Close()

	var list []ports.Index
	var cur *ports.Index
	for rows.Next() {
		var name, col string
		var isUnique, isPrimary bool
		if err := rows.Scan(&name, &isUnique, &isPrimary, &col); err != nil {
			return nil, c.normalizeError(err)
		}
		if cur == nil || cur.Name != name {
			list = append(list, ports.Index{Name: name, Unique: isUnique, Primary: isPrimary})
			cur = &list[len(list)-1]
		}
		cur.Columns = append(cur.Columns, col)
	}
	return list, c.normalizeError(rows.Err())
}

// GetSchemaGraph returns every base table with its columns plus all FK edges in
// the database, for the ER diagram.
func (c *SQLServerConnector) GetSchemaGraph(ctx context.Context, p domain.ConnectionProfile, password string, database string) (ports.SchemaGraph, error) {
	db, err := c.connect(p, password, database)
	if err != nil {
		return ports.SchemaGraph{}, err
	}
	defer db.Close()

	// Tables + columns (with PK/nullable) in one catalog query.
	const colsQ = `SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE,
    CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS is_pk
  FROM INFORMATION_SCHEMA.COLUMNS c
  JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'
  LEFT JOIN (
    SELECT ku.TABLE_NAME, ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
    JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
    WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
  ) pk ON pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
  ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`

	rows, err := db.QueryContext(ctx, colsQ)
	if err != nil {
		return ports.SchemaGraph{}, c.normalizeError(err)
	}
	defer rows.Close()

	var graph ports.SchemaGraph
	var curTbl *ports.SchemaGraphTable
	for rows.Next() {
		var tbl, col, typ, isNullable string
		var isPK int
		if err := rows.Scan(&tbl, &col, &typ, &isNullable, &isPK); err != nil {
			return ports.SchemaGraph{}, c.normalizeError(err)
		}
		if curTbl == nil || curTbl.Name != tbl {
			graph.Tables = append(graph.Tables, ports.SchemaGraphTable{Name: tbl})
			curTbl = &graph.Tables[len(graph.Tables)-1]
		}
		curTbl.Columns = append(curTbl.Columns, ports.ColumnInfo{
			Name:       col,
			Type:       typ,
			Nullable:   isNullable == "YES",
			PrimaryKey: isPK == 1,
		})
	}
	if err := rows.Err(); err != nil {
		return ports.SchemaGraph{}, c.normalizeError(err)
	}

	// All FK edges across the database (no per-table filter).
	const fkQ = `SELECT t.name AS from_table, cp.name AS from_col, rt.name AS ref_table, cr.name AS ref_col
  FROM sys.foreign_keys fk
  JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
  JOIN sys.tables t ON t.object_id = fk.parent_object_id
  JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
  JOIN sys.tables rt ON rt.object_id = fk.referenced_object_id
  JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id`

	frows, err := db.QueryContext(ctx, fkQ)
	if err != nil {
		return ports.SchemaGraph{}, c.normalizeError(err)
	}
	defer frows.Close()

	for frows.Next() {
		var fromTable, fromCol, toTable, toCol string
		if err := frows.Scan(&fromTable, &fromCol, &toTable, &toCol); err != nil {
			return ports.SchemaGraph{}, c.normalizeError(err)
		}
		graph.ForeignKeys = append(graph.ForeignKeys, ports.SchemaGraphFK{
			FromTable:  fromTable,
			FromColumn: fromCol,
			ToTable:    toTable,
			ToColumn:   toCol,
		})
	}
	return graph, c.normalizeError(frows.Err())
}

// GetTableDDL reconstructs a CREATE TABLE statement from catalog metadata,
// assembling full column types, identity flags and the PK column list, then
// delegating string assembly to BuildCreateTableDDL.
func (c *SQLServerConnector) GetTableDDL(ctx context.Context, p domain.ConnectionProfile, password string, database string, table string) (string, error) {
	db, err := c.connect(p, password, database)
	if err != nil {
		return "", err
	}
	defer db.Close()

	const q = `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION, c.NUMERIC_SCALE,
         c.IS_NULLABLE, c.COLUMN_DEFAULT,
         COLUMNPROPERTY(OBJECT_ID(@p1), c.COLUMN_NAME, 'IsIdentity') AS is_identity
  FROM INFORMATION_SCHEMA.COLUMNS c
  WHERE c.TABLE_NAME = @p2
  ORDER BY c.ORDINAL_POSITION`

	rows, err := db.QueryContext(ctx, q, table, table)
	if err != nil {
		return "", c.normalizeError(err)
	}
	defer rows.Close()

	var cols []DDLColumn
	for rows.Next() {
		var (
			name, dataType, isNullable    string
			charMaxLen, numPrec, numScale sql.NullInt64
			colDefault                    sql.NullString
			isIdentity                    sql.NullInt64
		)
		if err := rows.Scan(&name, &dataType, &charMaxLen, &numPrec, &numScale, &isNullable, &colDefault, &isIdentity); err != nil {
			return "", c.normalizeError(err)
		}
		col := DDLColumn{
			Name:     name,
			Type:     buildTypeString(dataType, charMaxLen, numPrec, numScale),
			Nullable: isNullable == "YES",
			Default:  colDefault.String,
		}
		if isIdentity.Valid && isIdentity.Int64 == 1 {
			col.Identity = true
			col.IdentitySeed = 1
			col.IdentityIncr = 1
		}
		cols = append(cols, col)
	}
	if err := rows.Err(); err != nil {
		return "", c.normalizeError(err)
	}

	// PK column list via the same TABLE_CONSTRAINTS/KEY_COLUMN_USAGE join.
	const pkQ = `SELECT ku.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
  JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
  WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_NAME = @p1
  ORDER BY ku.ORDINAL_POSITION`

	pkRows, err := db.QueryContext(ctx, pkQ, table)
	if err != nil {
		return "", c.normalizeError(err)
	}
	defer pkRows.Close()

	var pk []string
	for pkRows.Next() {
		var col string
		if err := pkRows.Scan(&col); err != nil {
			return "", c.normalizeError(err)
		}
		pk = append(pk, col)
	}
	if err := pkRows.Err(); err != nil {
		return "", c.normalizeError(err)
	}

	return BuildCreateTableDDL("dbo", table, cols, pk), nil
}

// buildTypeString assembles a faithful T-SQL type string from catalog metadata:
// (N) or (max) for char/binary types, (precision,scale) for decimal/numeric.
func buildTypeString(dataType string, charMaxLen, numPrec, numScale sql.NullInt64) string {
	switch strings.ToLower(dataType) {
	case "char", "varchar", "nchar", "nvarchar", "binary", "varbinary":
		if charMaxLen.Valid {
			if charMaxLen.Int64 == -1 {
				return dataType + "(max)"
			}
			return dataType + "(" + strconv.FormatInt(charMaxLen.Int64, 10) + ")"
		}
		return dataType
	case "decimal", "numeric":
		if numPrec.Valid {
			scale := int64(0)
			if numScale.Valid {
				scale = numScale.Int64
			}
			return dataType + "(" + strconv.FormatInt(numPrec.Int64, 10) + "," + strconv.FormatInt(scale, 10) + ")"
		}
		return dataType
	default:
		return dataType
	}
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
