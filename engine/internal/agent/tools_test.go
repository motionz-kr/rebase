package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// fakeSQL implements just the SQLConnector methods the read tools use.
type fakeSQL struct {
	tables       []ports.TableInfo
	columns      []ports.ColumnInfo
	colRefs      []ports.ColumnRef
	idxList      []ports.Index
	oneRow       []any
	lastQuery    string
	lastReadOnly bool
}

type fakeMCPWriteRepository struct {
	items map[string]*domain.MCPWriteProposal
}

func (f *fakeMCPWriteRepository) Create(_ context.Context, proposal *domain.MCPWriteProposal) error {
	if f.items == nil {
		f.items = map[string]*domain.MCPWriteProposal{}
	}
	copy := *proposal
	f.items[proposal.ID] = &copy
	return nil
}

func (f *fakeMCPWriteRepository) Get(_ context.Context, workspaceID, id string) (*domain.MCPWriteProposal, error) {
	proposal := f.items[id]
	if proposal == nil || proposal.WorkspaceID != workspaceID {
		return nil, fmt.Errorf("not found")
	}
	copy := *proposal
	return &copy, nil
}

func (f *fakeMCPWriteRepository) List(_ context.Context, workspaceID, profileID, status string, _ int) ([]domain.MCPWriteProposal, error) {
	var out []domain.MCPWriteProposal
	for _, proposal := range f.items {
		if proposal.WorkspaceID == workspaceID && (profileID == "" || proposal.ProfileID == profileID) && (status == "" || proposal.Status == status) {
			out = append(out, *proposal)
		}
	}
	return out, nil
}

func (f *fakeMCPWriteRepository) Update(_ context.Context, proposal *domain.MCPWriteProposal) error {
	return f.Create(context.Background(), proposal)
}

func (f *fakeSQL) ListColumns(_ context.Context, _ domain.ConnectionProfile, _ string, _ string) ([]ports.ColumnRef, error) {
	return f.colRefs, nil
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
	if f.idxList != nil {
		return f.idxList, nil
	}
	return []ports.Index{{Name: "PRIMARY", Columns: []string{"id"}, Primary: true, Unique: true}}, nil
}
func (f *fakeSQL) ListForeignKeys(_ context.Context, _ domain.ConnectionProfile, _ string, _ string, _ string) ([]ports.ForeignKey, error) {
	return []ports.ForeignKey{{Column: "owner_id", RefTable: "users", RefColumn: "id"}}, nil
}
func (f *fakeSQL) ExecuteQueryStream(_ context.Context, _ domain.ConnectionProfile, _ string, query string, readOnly bool, onStart func(int64), onHeader func([]string) error, onRow func([]any) error) (int64, error) {
	f.lastQuery = query
	f.lastReadOnly = readOnly
	onStart(1)
	if f.oneRow != nil {
		_ = onHeader([]string{"n"})
		_ = onRow(f.oneRow)
		return 0, nil
	}
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

func TestRegistryDispatchRecordsExecutedSQL(t *testing.T) {
	conn := &fakeSQL{}
	reg := NewSQLRegistry(conn, domainProfile(), "", "devdb")
	var queries []string
	ctx := WithQueryRecorder(context.Background(), func(query string) {
		queries = append(queries, query)
	})

	if _, err := reg.Dispatch(ctx, "explain_query", map[string]any{"sql": "SELECT * FROM users"}); err != nil {
		t.Fatalf("dispatch explain_query: %v", err)
	}
	if len(queries) != 1 || queries[0] != "EXPLAIN SELECT * FROM users" {
		t.Fatalf("recorded queries = %#v", queries)
	}
}

func TestRegistryProposeWriteCreatesApprovalWithoutExecuting(t *testing.T) {
	conn := &fakeSQL{}
	proposals := &fakeMCPWriteRepository{}
	reg := NewSQLRegistryWithMCPWrites(conn, domain.ConnectionProfile{ID: "profile-1"}, "", "devdb", MCPWriteConfig{
		Mode: domain.MCPWriteModeApproval, WorkspaceID: "default", ProfileID: "profile-1", Proposals: proposals,
	})

	out, err := reg.Dispatch(context.Background(), "propose_write", map[string]any{"sql": "UPDATE users SET name = 'Ada' WHERE id = 1"})
	if err != nil {
		t.Fatalf("propose_write: %v", err)
	}
	result, ok := out.(map[string]any)
	if !ok {
		t.Fatalf("propose_write result type = %T", out)
	}
	proposalID, ok := result["proposalId"].(string)
	if !ok || proposalID == "" || result["status"] != domain.MCPWritePending {
		t.Fatalf("propose_write result = %#v", result)
	}
	if conn.lastQuery != "" {
		t.Fatalf("proposal must not execute SQL, got %q", conn.lastQuery)
	}

	status, err := reg.Dispatch(context.Background(), "write_proposal_status", map[string]any{"proposalId": proposalID})
	if err != nil {
		t.Fatalf("write_proposal_status: %v", err)
	}
	statusMap := status.(map[string]any)
	if statusMap["status"] != domain.MCPWritePending || statusMap["sql"] != "UPDATE users SET name = 'Ada' WHERE id = 1" {
		t.Fatalf("proposal status = %#v", statusMap)
	}
	if proposals.items[proposalID].CreatedAt.IsZero() {
		t.Fatal("proposal should have a creation timestamp")
	}
}

func TestRegistryEnforcesMCPObjectScope(t *testing.T) {
	conn := &fakeSQL{tables: []ports.TableInfo{{Name: "users"}, {Name: "orders"}}}
	p := domain.ConnectionProfile{
		Driver:              "postgres",
		McpAllowedDatabases: `["devdb"]`,
		McpAllowedSchemas:   `["public"]`,
		McpAllowedTables:    `["users"]`,
	}
	reg := NewSQLRegistry(conn, p, "", "devdb")

	out, err := reg.Dispatch(context.Background(), "list_tables", map[string]any{})
	if err != nil {
		t.Fatalf("list_tables: %v", err)
	}
	b, _ := json.Marshal(out)
	if string(b) != `["users"]` {
		t.Fatalf("scoped list_tables = %s", b)
	}
	if _, err := reg.Dispatch(context.Background(), "run_select", map[string]any{"sql": "SELECT * FROM public.orders"}); err == nil {
		t.Fatal("run_select should reject a table outside the MCP scope")
	}
}

func TestRegistryAllowsAnExplicitlyAllowedNonDefaultSchema(t *testing.T) {
	conn := &fakeSQL{}
	p := domain.ConnectionProfile{
		Driver:            "postgres",
		McpAllowedSchemas: `["archive"]`,
	}
	reg := NewSQLRegistry(conn, p, "", "devdb")
	if _, err := reg.Dispatch(context.Background(), "run_select", map[string]any{"sql": "SELECT * FROM archive.orders"}); err != nil {
		t.Fatalf("explicitly allowed schema should be accepted: %v", err)
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

func TestProposeWriteDoesNotExecute(t *testing.T) {
	conn := &fakeSQL{}
	reg := NewSQLRegistry(conn, domainProfile(), "", "devdb")
	out, err := reg.Dispatch(context.Background(), "propose_write", map[string]any{"sql": "DELETE FROM users"})
	if err != nil {
		t.Fatalf("propose_write: %v", err)
	}
	if conn.lastQuery != "" {
		t.Errorf("propose_write must NOT execute; ran %q", conn.lastQuery)
	}
	b, _ := json.Marshal(out)
	if !containsSub(string(b), `"risk":"dangerous"`) {
		t.Errorf("WHERE-less DELETE should be flagged dangerous: %s", b)
	}
}

func TestRegistryFindColumn(t *testing.T) {
	conn := &fakeSQL{colRefs: []ports.ColumnRef{
		{Table: "users", Column: "owner_id", Type: "int"},
		{Table: "orders", Column: "id", Type: "int"},
		{Table: "audit", Column: "owner_email", Type: "text"},
	}}
	reg := NewSQLRegistry(conn, domainProfile(), "", "devdb")
	out, err := reg.Dispatch(context.Background(), "find_column", map[string]any{"name": "owner"})
	if err != nil {
		t.Fatalf("find_column: %v", err)
	}
	b, _ := json.Marshal(out)
	s := string(b)
	if !containsSub(s, "owner_id") || !containsSub(s, "owner_email") || containsSub(s, `"orders"`) {
		t.Errorf("find_column should match owner_* only: %s", s)
	}
}

func TestRegistryProfileTable(t *testing.T) {
	conn := &fakeSQL{
		columns: []ports.ColumnInfo{{Name: "id"}, {Name: "email"}},
		oneRow:  []any{int64(10), int64(10), int64(7)}, // total=10, id=10 non-null, email=7
	}
	reg := NewSQLRegistry(conn, domainProfile(), "", "devdb")
	out, err := reg.Dispatch(context.Background(), "profile_table", map[string]any{"table": "users"})
	if err != nil {
		t.Fatalf("profile_table: %v", err)
	}
	if !conn.lastReadOnly {
		t.Error("profile_table must run read-only")
	}
	b, _ := json.Marshal(out)
	s := string(b)
	if !containsSub(s, `"rowCount":10`) || !containsSub(s, `"nulls":3`) {
		t.Errorf("profile should report total 10 and email nulls 3: %s", s)
	}
}

func TestRegistryTableStats(t *testing.T) {
	conn := &fakeSQL{oneRow: []any{int64(1234), int64(56789)}}
	reg := NewSQLRegistry(conn, domainProfile(), "", "devdb")
	out, err := reg.Dispatch(context.Background(), "table_stats", map[string]any{"table": "users"})
	if err != nil {
		t.Fatalf("table_stats: %v", err)
	}
	b, _ := json.Marshal(out)
	if !containsSub(string(b), `"tableRows":1234`) || !containsSub(string(b), `"totalBytes":56789`) {
		t.Errorf("table_stats wrong: %s", b)
	}
}

func TestRegistryDatabaseStorageSummary(t *testing.T) {
	conn := &fakeSQL{oneRow: []any{int64(2), int64(1024), int64(512), int64(1536)}}
	reg := NewSQLRegistry(conn, domainProfile(), "", "devdb")
	out, err := reg.Dispatch(context.Background(), "database_storage_summary", map[string]any{"limit": float64(5)})
	if err != nil {
		t.Fatalf("database_storage_summary: %v", err)
	}
	if !conn.lastReadOnly {
		t.Error("database_storage_summary must run read-only")
	}
	if !containsSub(conn.lastQuery, "information_schema.tables") || !containsSub(conn.lastQuery, "ORDER BY total_bytes DESC LIMIT 5") {
		t.Errorf("mysql storage summary should read information_schema with the requested limit, got %q", conn.lastQuery)
	}
	b, _ := json.Marshal(out)
	s := string(b)
	if !containsSub(s, `"diskFreeAvailable":false`) || !containsSub(s, "databaseUsage") || !containsSub(s, "largestTables") {
		t.Errorf("storage summary should include usage, largest tables, and disk-free limitation: %s", s)
	}
}

func TestRegistryFindDuplicateIndexes(t *testing.T) {
	conn := &fakeSQL{idxList: []ports.Index{
		{Name: "idx_a", Columns: []string{"email"}},
		{Name: "idx_b", Columns: []string{"email"}}, // duplicate of idx_a
		{Name: "PRIMARY", Columns: []string{"id"}},
	}}
	reg := NewSQLRegistry(conn, domainProfile(), "", "devdb")
	out, err := reg.Dispatch(context.Background(), "find_duplicate_indexes", map[string]any{"table": "users"})
	if err != nil {
		t.Fatalf("find_duplicate_indexes: %v", err)
	}
	b, _ := json.Marshal(out)
	s := string(b)
	if !containsSub(s, "idx_a") || !containsSub(s, "idx_b") || containsSub(s, "PRIMARY") {
		t.Errorf("should flag idx_a+idx_b (same columns) only: %s", s)
	}
}

func TestRegistrySlowQueriesMySQLSource(t *testing.T) {
	conn := &fakeSQL{}
	reg := NewSQLRegistry(conn, domainProfile(), "", "devdb") // empty driver → mysql branch
	if _, err := reg.Dispatch(context.Background(), "slow_queries", map[string]any{}); err != nil {
		t.Fatalf("slow_queries: %v", err)
	}
	if !conn.lastReadOnly || !containsSub(conn.lastQuery, "events_statements_summary_by_digest") {
		t.Errorf("mysql slow_queries should read perf_schema read-only: %q", conn.lastQuery)
	}
}

func TestTableStatsQueryUsesQualifiedTableReference(t *testing.T) {
	tests := []struct {
		driver string
		table  string
		want   []string
	}{
		{driver: "mysql", table: "analytics.orders", want: []string{"table_schema = 'analytics'", "table_name = 'orders'"}},
		{driver: "postgres", table: "reporting.orders", want: []string{"n.nspname = 'reporting'", "c.relname = 'orders'"}},
		{driver: "sqlite", table: "main.orders", want: []string{`FROM "main"."orders"`}},
		{driver: "sqlserver", table: "reporting.orders", want: []string{"s.name = 'reporting'", "t.name = 'orders'"}},
	}

	for _, tt := range tests {
		t.Run(tt.driver, func(t *testing.T) {
			query, err := tableStatsQuery(tt.driver, "devdb", tt.table)
			if err != nil {
				t.Fatalf("tableStatsQuery: %v", err)
			}
			for _, want := range tt.want {
				if !containsSub(query, want) {
					t.Errorf("query %q does not contain %q", query, want)
				}
			}
		})
	}
}

func TestTableStatsQueryUsesDefaultsForUnqualifiedTable(t *testing.T) {
	mysql, err := tableStatsQuery("mysql", "devdb", "orders")
	if err != nil || !containsSub(mysql, "table_schema = 'devdb'") || !containsSub(mysql, "table_name = 'orders'") {
		t.Fatalf("mysql default query = %q, err=%v", mysql, err)
	}

	postgres, err := tableStatsQuery("postgres", "devdb", "orders")
	if err != nil || !containsSub(postgres, "n.nspname = current_schema()") {
		t.Fatalf("postgres default query = %q, err=%v", postgres, err)
	}
}

func TestTableStatsQueryRejectsMalformedReference(t *testing.T) {
	if _, err := tableStatsQuery("postgres", "devdb", "a.b.c.d"); err == nil {
		t.Fatal("expected malformed table reference to be rejected")
	}
}

func TestRegistryUnknownTool(t *testing.T) {
	reg := NewSQLRegistry(&fakeSQL{}, domainProfile(), "", "devdb")
	if _, err := reg.Dispatch(context.Background(), "nope", nil); err == nil {
		t.Fatal("expected error for unknown tool")
	}
}

func TestQuoteIdent_SQLiteUsesDoubleQuotes(t *testing.T) {
	got := quoteIdent("sqlite", `we"ird`)
	want := `"we""ird"`
	if got != want {
		t.Fatalf("quoteIdent sqlite = %q, want %q", got, want)
	}
}

func TestQuoteIdent_SQLServerUsesBrackets(t *testing.T) {
	if got := quoteIdent("sqlserver", "we]ird"); got != "[we]]ird]" {
		t.Fatalf("quoteIdent sqlserver = %q, want %q", got, "[we]]ird]")
	}
}
