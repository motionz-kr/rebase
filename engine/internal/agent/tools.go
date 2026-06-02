package agent

import (
	"context"
	"fmt"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// sqlReader is the subset of ports.SQLConnector the read tools need (kept small
// so tests can fake it without implementing the full connector).
type sqlReader interface {
	ListTables(ctx context.Context, p domain.ConnectionProfile, password, database string) ([]ports.TableInfo, error)
	DescribeTable(ctx context.Context, p domain.ConnectionProfile, password, database, table string) (ports.TableDescription, error)
	GetTableDDL(ctx context.Context, p domain.ConnectionProfile, password, database, table string) (string, error)
	ListIndexes(ctx context.Context, p domain.ConnectionProfile, password, database, table string) ([]ports.Index, error)
	ListForeignKeys(ctx context.Context, p domain.ConnectionProfile, password, database, table string) ([]ports.ForeignKey, error)
	ExecuteQueryStream(ctx context.Context, p domain.ConnectionProfile, password string, query string, readOnly bool, onSessionStart func(sessionID int64), onHeader func(columns []string) error, onRow func(row []any) error) (int64, error)
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

	return r
}
