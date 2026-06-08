package agent

import (
	"context"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type fakeCaller struct {
	specs  []ports.ToolSpec
	called map[string]map[string]any
}

func (f *fakeCaller) ListTools(ctx context.Context) ([]ports.ToolSpec, error) { return f.specs, nil }
func (f *fakeCaller) Call(ctx context.Context, name string, args map[string]any) (any, error) {
	if f.called == nil {
		f.called = map[string]map[string]any{}
	}
	f.called[name] = args
	return "RAN:" + name, nil
}
func (f *fakeCaller) Close() error { return nil }

func TestAttachMCPServers_Namespacing(t *testing.T) {
	reg := &Registry{tools: map[string]Tool{}}
	fc := &fakeCaller{specs: []ports.ToolSpec{{Name: "read", Description: "Read"}}}
	dial := func(ctx context.Context, s domain.McpServer) (McpCaller, error) { return fc, nil }

	cleanup, warnings := AttachMCPServers(context.Background(), reg,
		[]domain.McpServer{{Name: "Files", Trusted: true, Enabled: true}}, dial)
	defer cleanup()

	if len(warnings) != 0 {
		t.Fatalf("unexpected warnings: %v", warnings)
	}
	names := map[string]bool{}
	for _, sp := range reg.Specs() {
		names[sp.Name] = true
	}
	if !names["mcp__files__read"] {
		t.Fatalf("expected proxy tool mcp__files__read, got %v", names)
	}
	out, err := reg.Dispatch(context.Background(), "mcp__files__read", map[string]any{"p": 1})
	if err != nil || out != "RAN:read" {
		t.Fatalf("trusted dispatch: %v %v", out, err)
	}
}

func TestAttachMCPServers_UntrustedProposes(t *testing.T) {
	reg := &Registry{tools: map[string]Tool{}}
	fc := &fakeCaller{specs: []ports.ToolSpec{{Name: "write", Description: "Write"}}}
	dial := func(ctx context.Context, s domain.McpServer) (McpCaller, error) { return fc, nil }
	cleanup, _ := AttachMCPServers(context.Background(), reg,
		[]domain.McpServer{{ID: "srv1", Name: "fs", Trusted: false, Enabled: true}}, dial)
	defer cleanup()

	out, err := reg.Dispatch(context.Background(), "mcp__fs__write", map[string]any{"x": 1})
	if err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	m, ok := out.(map[string]any)
	if !ok || m["proposed"] != true || m["server"] != "fs" || m["tool"] != "write" || m["serverId"] != "srv1" {
		t.Fatalf("expected proposal, got %#v", out)
	}
	if len(fc.called) != 0 {
		t.Fatal("untrusted tool must NOT execute")
	}
}

func TestAttachMCPServers_FailureSkips(t *testing.T) {
	reg := &Registry{tools: map[string]Tool{}}
	dial := func(ctx context.Context, s domain.McpServer) (McpCaller, error) {
		return nil, context.DeadlineExceeded
	}
	cleanup, warnings := AttachMCPServers(context.Background(), reg,
		[]domain.McpServer{{Name: "broken", Enabled: true}}, dial)
	defer cleanup()
	if len(warnings) != 1 {
		t.Fatalf("expected 1 warning, got %v", warnings)
	}
	if len(reg.Specs()) != 0 {
		t.Fatal("failed server should add no tools")
	}
}
