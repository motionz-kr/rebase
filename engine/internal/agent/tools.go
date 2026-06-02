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

	return r
}
