package agent

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// fakeSQL implements just the SQLConnector methods the read tools use.
type fakeSQL struct {
	tables       []ports.TableInfo
	columns      []ports.ColumnInfo
	lastQuery    string
	lastReadOnly bool
}

func (f *fakeSQL) ListTables(_ context.Context, _ domain.ConnectionProfile, _ string, _ string) ([]ports.TableInfo, error) {
	return f.tables, nil
}
func (f *fakeSQL) DescribeTable(_ context.Context, _ domain.ConnectionProfile, _ string, _ string, _ string) (ports.TableDescription, error) {
	return ports.TableDescription{Columns: f.columns}, nil
}
func (f *fakeSQL) GetTableDDL(_ context.Context, _ domain.ConnectionProfile, _ string, _ string, table string) (string, error) {
	return "CREATE TABLE " + table + " (id INT)", nil
}
func (f *fakeSQL) ListIndexes(_ context.Context, _ domain.ConnectionProfile, _ string, _ string, _ string) ([]ports.Index, error) {
	return []ports.Index{{Name: "PRIMARY", Columns: []string{"id"}, Primary: true, Unique: true}}, nil
}
func (f *fakeSQL) ListForeignKeys(_ context.Context, _ domain.ConnectionProfile, _ string, _ string, _ string) ([]ports.ForeignKey, error) {
	return []ports.ForeignKey{{Column: "owner_id", RefTable: "users", RefColumn: "id"}}, nil
}
func (f *fakeSQL) ExecuteQueryStream(_ context.Context, _ domain.ConnectionProfile, _ string, query string, readOnly bool, onStart func(int64), onHeader func([]string) error, onRow func([]any) error) (int64, error) {
	f.lastQuery = query
	f.lastReadOnly = readOnly
	onStart(1)
	_ = onHeader([]string{"id", "name"})
	_ = onRow([]any{int64(1), "alice"})
	_ = onRow([]any{int64(2), "bob"})
	return 0, nil
}

// domainProfile is a shared test helper (used by service_test.go too).
func domainProfile() domain.ConnectionProfile { return domain.ConnectionProfile{} }

func TestRegistryDispatchListTables(t *testing.T) {
	conn := &fakeSQL{tables: []ports.TableInfo{{Name: "users"}, {Name: "orders"}}}
	reg := NewSQLRegistry(conn, domainProfile(), "", "devdb")

	if len(reg.Specs()) == 0 {
		t.Fatal("registry should advertise tool specs")
	}

	out, err := reg.Dispatch(context.Background(), "list_tables", map[string]any{})
	if err != nil {
		t.Fatalf("dispatch list_tables: %v", err)
	}
	b, _ := json.Marshal(out)
	if got := string(b); got != `["users","orders"]` {
		t.Fatalf("list_tables = %s, want [\"users\",\"orders\"]", got)
	}
}

func TestRegistryIntrospectionTools(t *testing.T) {
	reg := NewSQLRegistry(&fakeSQL{}, domainProfile(), "", "devdb")
	ctx := context.Background()

	ddl, err := reg.Dispatch(ctx, "get_table_ddl", map[string]any{"table": "orders"})
	if err != nil || ddl != "CREATE TABLE orders (id INT)" {
		t.Fatalf("get_table_ddl = %v err=%v", ddl, err)
	}
	idx, err := reg.Dispatch(ctx, "list_indexes", map[string]any{"table": "orders"})
	if err != nil {
		t.Fatalf("list_indexes: %v", err)
	}
	if b, _ := json.Marshal(idx); !containsSub(string(b), "PRIMARY") {
		t.Errorf("list_indexes result missing PRIMARY: %s", b)
	}
	fks, err := reg.Dispatch(ctx, "list_foreign_keys", map[string]any{"table": "orders"})
	if err != nil {
		t.Fatalf("list_foreign_keys: %v", err)
	}
	if b, _ := json.Marshal(fks); !containsSub(string(b), "users") {
		t.Errorf("list_foreign_keys result missing ref table: %s", b)
	}
}

func containsSub(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestRegistryRunSelectAndExplain(t *testing.T) {
	conn := &fakeSQL{}
	reg := NewSQLRegistry(conn, domainProfile(), "", "devdb")
	ctx := context.Background()

	out, err := reg.Dispatch(ctx, "run_select", map[string]any{"sql": "SELECT * FROM users"})
	if err != nil {
		t.Fatalf("run_select: %v", err)
	}
	if !conn.lastReadOnly {
		t.Error("run_select must execute read-only")
	}
	b, _ := json.Marshal(out)
	if !containsSub(string(b), `"rowCount":2`) || !containsSub(string(b), "alice") {
		t.Errorf("run_select result wrong: %s", b)
	}

	if _, err := reg.Dispatch(ctx, "explain_query", map[string]any{"sql": "SELECT 1"}); err != nil {
		t.Fatalf("explain_query: %v", err)
	}
	if conn.lastQuery != "EXPLAIN SELECT 1" {
		t.Errorf("explain_query should prefix EXPLAIN, got %q", conn.lastQuery)
	}
}

func TestRegistryUnknownTool(t *testing.T) {
	reg := NewSQLRegistry(&fakeSQL{}, domainProfile(), "", "devdb")
	if _, err := reg.Dispatch(context.Background(), "nope", nil); err == nil {
		t.Fatal("expected error for unknown tool")
	}
}
