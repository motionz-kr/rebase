package agent

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// toInt coerces a DB-driver numeric value (int64 / float64 / []byte / string)
// to int64.
func toInt(v any) int64 {
	switch t := v.(type) {
	case int64:
		return t
	case int:
		return int64(t)
	case float64:
		return int64(t)
	case []byte:
		n, _ := strconv.ParseInt(string(t), 10, 64)
		return n
	case string:
		n, _ := strconv.ParseInt(t, 10, 64)
		return n
	default:
		return 0
	}
}

// sqlReader is the subset of ports.SQLConnector the read tools need (kept small
// so tests can fake it without implementing the full connector).
type sqlReader interface {
	ListTables(ctx context.Context, p domain.ConnectionProfile, password, database string) ([]ports.TableInfo, error)
	DescribeTable(ctx context.Context, p domain.ConnectionProfile, password, database, table string) (ports.TableDescription, error)
	GetTableDDL(ctx context.Context, p domain.ConnectionProfile, password, database, table string) (string, error)
	ListIndexes(ctx context.Context, p domain.ConnectionProfile, password, database, table string) ([]ports.Index, error)
	ListForeignKeys(ctx context.Context, p domain.ConnectionProfile, password, database, table string) ([]ports.ForeignKey, error)
	ListColumns(ctx context.Context, p domain.ConnectionProfile, password, database string) ([]ports.ColumnRef, error)
	ExecuteQueryStream(ctx context.Context, p domain.ConnectionProfile, password string, query string, readOnly bool, onSessionStart func(sessionID int64), onHeader func(columns []string) error, onRow func(row []any) error) (int64, error)
}

// quoteIdent quotes a SQL identifier for the given driver.
func quoteIdent(driver, ident string) string {
	if driver == "postgres" {
		return `"` + strings.ReplaceAll(ident, `"`, `""`) + `"`
	}
	return "`" + strings.ReplaceAll(ident, "`", "``") + "`"
}

// readQueryLimit caps how many rows a read tool collects into the model context.
const readQueryLimit = 200

type queryResult struct {
	Columns   []string `json:"columns"`
	Rows      [][]any  `json:"rows"`
	RowCount  int      `json:"rowCount"`
	Truncated bool     `json:"truncated"`
}

// runReadQuery executes a read-only query and collects up to readQueryLimit rows.
func runReadQuery(ctx context.Context, conn sqlReader, p domain.ConnectionProfile, password, sql string) (queryResult, error) {
	res := queryResult{Rows: [][]any{}}
	_, err := conn.ExecuteQueryStream(ctx, p, password, sql, true,
		func(int64) {},
		func(cols []string) error { res.Columns = cols; return nil },
		func(row []any) error {
			if len(res.Rows) >= readQueryLimit {
				res.Truncated = true
				return nil
			}
			res.Rows = append(res.Rows, row)
			return nil
		},
	)
	if err != nil {
		return queryResult{}, err
	}
	res.RowCount = len(res.Rows)
	return res, nil
}

type Tool struct {
	Spec ports.ToolSpec
	Run  func(ctx context.Context, args map[string]any) (any, error)
}

type Registry struct {
	tools map[string]Tool
	order []string
}

func (r *Registry) Specs() []ports.ToolSpec {
	specs := make([]ports.ToolSpec, 0, len(r.order))
	for _, name := range r.order {
		specs = append(specs, r.tools[name].Spec)
	}
	return specs
}

func (r *Registry) Dispatch(ctx context.Context, name string, args map[string]any) (any, error) {
	t, ok := r.tools[name]
	if !ok {
		return nil, fmt.Errorf("unknown tool %q", name)
	}
	return t.Run(ctx, args)
}

func (r *Registry) add(t Tool) {
	r.tools[t.Spec.Name] = t
	r.order = append(r.order, t.Spec.Name)
}

func strArg(args map[string]any, key string) string {
	if v, ok := args[key].(string); ok {
		return v
	}
	return ""
}

// NewSQLRegistry builds the read-only tool set bound to one connection profile.
func NewSQLRegistry(conn sqlReader, p domain.ConnectionProfile, password, database string) *Registry {
	r := &Registry{tools: map[string]Tool{}}

	r.add(Tool{
		Spec: ports.ToolSpec{
			Name:        "list_tables",
			Description: "List table names in the current database.",
			Schema:      map[string]any{"type": "object", "properties": map[string]any{}},
		},
		Run: func(ctx context.Context, args map[string]any) (any, error) {
			tables, err := conn.ListTables(ctx, p, password, database)
			if err != nil {
				return nil, err
			}
			names := make([]string, len(tables))
			for i, t := range tables {
				names[i] = t.Name
			}
			return names, nil
		},
	})

	r.add(Tool{
		Spec: ports.ToolSpec{
			Name:        "describe_table",
			Description: "Return the columns (name, type, nullable, primaryKey) of a table.",
			Schema: map[string]any{
				"type":       "object",
				"properties": map[string]any{"table": map[string]any{"type": "string"}},
				"required":   []string{"table"},
			},
		},
		Run: func(ctx context.Context, args map[string]any) (any, error) {
			desc, err := conn.DescribeTable(ctx, p, password, database, strArg(args, "table"))
			if err != nil {
				return nil, err
			}
			return desc.Columns, nil
		},
	})

	tableArgSchema := map[string]any{
		"type":       "object",
		"properties": map[string]any{"table": map[string]any{"type": "string"}},
		"required":   []string{"table"},
	}

	r.add(Tool{
		Spec: ports.ToolSpec{Name: "get_table_ddl", Description: "Return the CREATE TABLE statement (DDL) for a table.", Schema: tableArgSchema},
		Run: func(ctx context.Context, args map[string]any) (any, error) {
			return conn.GetTableDDL(ctx, p, password, database, strArg(args, "table"))
		},
	})

	r.add(Tool{
		Spec: ports.ToolSpec{Name: "list_indexes", Description: "List the indexes (name, columns, unique, primary) of a table.", Schema: tableArgSchema},
		Run: func(ctx context.Context, args map[string]any) (any, error) {
			return conn.ListIndexes(ctx, p, password, database, strArg(args, "table"))
		},
	})

	r.add(Tool{
		Spec: ports.ToolSpec{Name: "list_foreign_keys", Description: "List the foreign keys (column, referenced table/column) of a table.", Schema: tableArgSchema},
		Run: func(ctx context.Context, args map[string]any) (any, error) {
			return conn.ListForeignKeys(ctx, p, password, database, strArg(args, "table"))
		},
	})

	sqlArgSchema := map[string]any{
		"type":       "object",
		"properties": map[string]any{"sql": map[string]any{"type": "string"}},
		"required":   []string{"sql"},
	}

	r.add(Tool{
		Spec: ports.ToolSpec{
			Name:        "run_select",
			Description: "Run a read-only SELECT and return up to 200 rows. Rejects writes.",
			Schema:      sqlArgSchema,
		},
		Run: func(ctx context.Context, args map[string]any) (any, error) {
			return runReadQuery(ctx, conn, p, password, strArg(args, "sql"))
		},
	})

	r.add(Tool{
		Spec: ports.ToolSpec{
			Name:        "explain_query",
			Description: "Return the database's execution plan for a query (runs EXPLAIN).",
			Schema:      sqlArgSchema,
		},
		Run: func(ctx context.Context, args map[string]any) (any, error) {
			return runReadQuery(ctx, conn, p, password, "EXPLAIN "+strArg(args, "sql"))
		},
	})

	r.add(Tool{
		Spec: ports.ToolSpec{
			Name:        "find_column",
			Description: "Find every table that has a column whose name contains the given text (reverse lookup).",
			Schema: map[string]any{
				"type":       "object",
				"properties": map[string]any{"name": map[string]any{"type": "string"}},
				"required":   []string{"name"},
			},
		},
		Run: func(ctx context.Context, args map[string]any) (any, error) {
			cols, err := conn.ListColumns(ctx, p, password, database)
			if err != nil {
				return nil, err
			}
			needle := strings.ToLower(strArg(args, "name"))
			out := make([]ports.ColumnRef, 0)
			for _, c := range cols {
				if strings.Contains(strings.ToLower(c.Column), needle) {
					out = append(out, c)
				}
			}
			return out, nil
		},
	})

	r.add(Tool{
		Spec: ports.ToolSpec{
			Name:        "profile_table",
			Description: "Profile a table: total row count and the null fraction of each column.",
			Schema:      tableArgSchema,
		},
		Run: func(ctx context.Context, args map[string]any) (any, error) {
			table := strArg(args, "table")
			desc, err := conn.DescribeTable(ctx, p, password, database, table)
			if err != nil {
				return nil, err
			}
			cols := desc.Columns
			if len(cols) > 40 {
				cols = cols[:40]
			}
			sel := []string{"COUNT(*) AS n"}
			for i, c := range cols {
				sel = append(sel, fmt.Sprintf("COUNT(%s) AS c%d", quoteIdent(p.Driver, c.Name), i))
			}
			sql := "SELECT " + strings.Join(sel, ", ") + " FROM " + quoteIdent(p.Driver, table)
			res, err := runReadQuery(ctx, conn, p, password, sql)
			if err != nil {
				return nil, err
			}
			if len(res.Rows) == 0 || len(res.Rows[0]) == 0 {
				return map[string]any{"rowCount": 0, "columns": []any{}}, nil
			}
			row := res.Rows[0]
			total := toInt(row[0])
			profile := make([]map[string]any, 0, len(cols))
			for i, c := range cols {
				nonNull := toInt(row[i+1])
				nullPct := 0.0
				if total > 0 {
					nullPct = float64(total-nonNull) / float64(total)
				}
				profile = append(profile, map[string]any{"column": c.Name, "type": c.Type, "nulls": total - nonNull, "nullFraction": nullPct})
			}
			return map[string]any{"rowCount": total, "columns": profile}, nil
		},
	})

	r.add(Tool{
		Spec: ports.ToolSpec{
			Name:        "table_stats",
			Description: "Estimated row count and on-disk size (bytes) of a table.",
			Schema:      tableArgSchema,
		},
		Run: func(ctx context.Context, args map[string]any) (any, error) {
			table := strArg(args, "table")
			lit := "'" + strings.ReplaceAll(table, "'", "''") + "'"
			var sql string
			if p.Driver == "postgres" {
				sql = "SELECT c.reltuples::bigint AS rows, pg_total_relation_size(c.oid) AS bytes " +
					"FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace " +
					"WHERE c.relname = " + lit + " AND n.nspname = current_schema()"
			} else {
				sql = "SELECT table_rows AS rows, data_length + index_length AS bytes " +
					"FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = " + lit
			}
			res, err := runReadQuery(ctx, conn, p, password, sql)
			if err != nil {
				return nil, err
			}
			if len(res.Rows) == 0 || len(res.Rows[0]) < 2 {
				return map[string]any{"exists": false}, nil
			}
			row := res.Rows[0]
			return map[string]any{"tableRows": toInt(row[0]), "totalBytes": toInt(row[1])}, nil
		},
	})

	r.add(Tool{
		Spec: ports.ToolSpec{
			Name: "propose_write",
			Description: "Propose an INSERT/UPDATE/DELETE or DDL (CREATE/ALTER/DROP) statement. " +
				"Returns the SQL with a safety assessment. This does NOT execute — the user reviews and runs it.",
			Schema: sqlArgSchema,
		},
		Run: func(_ context.Context, args map[string]any) (any, error) {
			sql := strArg(args, "sql")
			c := ClassifyStatement(sql)
			return map[string]any{
				"proposed": true,
				"sql":      sql,
				"risk":     c.Risk,
				"reasons":  c.Reasons,
			}, nil
		},
	})

	return r
}
