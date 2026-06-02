package llm

import (
	"context"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

func collect(p ports.LLMProvider, req ports.LLMRequest) []ports.LLMEvent {
	var out []ports.LLMEvent
	_ = p.Complete(context.Background(), req, func(e ports.LLMEvent) { out = append(out, e) })
	return out
}

func TestStubRequestsToolForSchemaQuestion(t *testing.T) {
	out := collect(NewStubProvider(), ports.LLMRequest{
		Messages: []ports.LLMMessage{{Role: ports.RoleUser, Text: "how many tables are there?"}},
	})
	var call *ports.ToolCall
	for _, e := range out {
		if e.Kind == ports.EventToolCall {
			call = e.ToolCall
		}
	}
	if call == nil || call.Name != "list_tables" {
		t.Fatalf("expected a list_tables tool call, got %+v", out)
	}
}

func TestStubAnswersFromToolResult(t *testing.T) {
	out := collect(NewStubProvider(), ports.LLMRequest{
		Messages: []ports.LLMMessage{
			{Role: ports.RoleUser, Text: "how many tables?"},
			{Role: ports.RoleAssistant, ToolName: "list_tables", ToolCallID: "stub-1"},
			{Role: ports.RoleTool, ToolCallID: "stub-1", ToolName: "list_tables", Text: `["users","orders"]`},
		},
	})
	var text string
	var done bool
	for _, e := range out {
		if e.Kind == ports.EventText {
			text += e.Text
		}
		if e.Kind == ports.EventDone {
			done = true
		}
	}
	if !done {
		t.Error("expected EventDone")
	}
	if want := "users"; !containsStr(text, want) {
		t.Errorf("answer %q should echo the tool result containing %q", text, want)
	}
}

func containsStr(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || (len(sub) > 0 && indexOf(s, sub) >= 0))
}
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
