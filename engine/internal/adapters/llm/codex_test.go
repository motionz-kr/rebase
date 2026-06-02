package llm

import (
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

func TestDecodeCodexLine(t *testing.T) {
	// agent_message → text
	ev := decodeCodexLine([]byte(`{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"1 table: demo_users"}}`))
	if len(ev) != 1 || ev[0].Kind != ports.EventText || !strings.Contains(ev[0].Text, "demo_users") {
		t.Fatalf("agent_message: %+v", ev)
	}
	// mcp_tool_call started → tool call chip
	ev = decodeCodexLine([]byte(`{"type":"item.started","item":{"type":"mcp_tool_call","server":"rebase","tool":"list_tables","status":"in_progress"}}`))
	if len(ev) != 1 || ev[0].Kind != ports.EventToolCall || ev[0].ToolCall.Name != "list_tables" {
		t.Fatalf("mcp_tool_call: %+v", ev)
	}
	// turn.completed → done
	ev = decodeCodexLine([]byte(`{"type":"turn.completed","usage":{}}`))
	if len(ev) != 1 || ev[0].Kind != ports.EventDone {
		t.Fatalf("turn.completed: %+v", ev)
	}
	// thread.started / turn.started → ignored
	if ev := decodeCodexLine([]byte(`{"type":"thread.started"}`)); ev != nil {
		t.Fatalf("thread.started should be ignored: %+v", ev)
	}
}

func TestBuildCodexArgs(t *testing.T) {
	args := buildCodexArgs("/path/to/engine", "prof-123", "gpt-5-codex")
	j := strings.Join(args, " ")
	for _, want := range []string{
		"exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox",
		`mcp_servers.rebase.command="/path/to/engine"`, `"-mcp","prof-123"`, "-m gpt-5-codex",
	} {
		if !strings.Contains(j, want) {
			t.Errorf("buildCodexArgs missing %q: %s", want, j)
		}
	}
}
