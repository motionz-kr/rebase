package llm

import (
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

func TestDecodeClaudeLine(t *testing.T) {
	// assistant text block
	ev := decodeClaudeLine([]byte(`{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}`))
	if len(ev) != 1 || ev[0].Kind != ports.EventText || ev[0].Text != "Hello" {
		t.Fatalf("text block: %+v", ev)
	}

	// assistant tool_use block
	ev = decodeClaudeLine([]byte(`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"list_tables","input":{"x":1}}]}}`))
	if len(ev) != 1 || ev[0].Kind != ports.EventToolCall || ev[0].ToolCall.Name != "list_tables" {
		t.Fatalf("tool_use block: %+v", ev)
	}

	// result success → done
	ev = decodeClaudeLine([]byte(`{"type":"result","subtype":"success","is_error":false,"result":"final"}`))
	if len(ev) != 1 || ev[0].Kind != ports.EventDone {
		t.Fatalf("result success: %+v", ev)
	}

	// result error → error + done
	ev = decodeClaudeLine([]byte(`{"type":"result","subtype":"error","is_error":true,"result":"boom"}`))
	kinds := map[ports.LLMEventKind]bool{}
	for _, e := range ev {
		kinds[e.Kind] = true
	}
	if !kinds[ports.EventError] || !kinds[ports.EventDone] {
		t.Fatalf("result error should emit error+done: %+v", ev)
	}

	// system/init lines are ignored
	if ev := decodeClaudeLine([]byte(`{"type":"system","subtype":"init"}`)); ev != nil {
		t.Fatalf("system line should be ignored: %+v", ev)
	}
}

func TestSanitizeEnv(t *testing.T) {
	in := []string{
		"PATH=/usr/bin",
		"ANTHROPIC_BASE_URL=https://proxy",
		"ANTHROPIC_API_KEY=",
		"CLAUDE_CODE_ENTRYPOINT=cli",
		"HOME=/Users/x",
	}
	out := sanitizeEnv(in)
	joined := strings.Join(out, "\n")
	for _, banned := range []string{"ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_"} {
		if strings.Contains(joined, banned) {
			t.Errorf("sanitizeEnv kept %q: %v", banned, out)
		}
	}
	for _, keep := range []string{"PATH=/usr/bin", "HOME=/Users/x"} {
		if !strings.Contains(joined, keep) {
			t.Errorf("sanitizeEnv dropped %q", keep)
		}
	}
}

func TestBuildClaudeArgs(t *testing.T) {
	args := buildClaudeArgs("/tmp/mcp.json", "default")
	j := strings.Join(args, " ")
	for _, want := range []string{
		"-p", "--verbose", "--output-format stream-json",
		"--mcp-config /tmp/mcp.json", "--strict-mcp-config",
		"--allowedTools mcp__rebase__*", "--permission-mode default",
	} {
		if !strings.Contains(j, want) {
			t.Errorf("buildClaudeArgs missing %q: %s", want, j)
		}
	}
}
