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
	tables  []ports.TableInfo
	columns []ports.ColumnInfo
}

func (f *fakeSQL) ListTables(_ context.Context, _ domain.ConnectionProfile, _ string, _ string) ([]ports.TableInfo, error) {
	return f.tables, nil
}
func (f *fakeSQL) DescribeTable(_ context.Context, _ domain.ConnectionProfile, _ string, _ string, _ string) (ports.TableDescription, error) {
	return ports.TableDescription{Columns: f.columns}, nil
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

func TestRegistryUnknownTool(t *testing.T) {
	reg := NewSQLRegistry(&fakeSQL{}, domainProfile(), "", "devdb")
	if _, err := reg.Dispatch(context.Background(), "nope", nil); err == nil {
		t.Fatal("expected error for unknown tool")
	}
}
