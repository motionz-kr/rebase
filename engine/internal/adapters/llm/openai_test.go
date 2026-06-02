package llm

import (
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

func TestBuildOpenAIBody(t *testing.T) {
	req := ports.LLMRequest{
		System: "db assistant",
		Model:  "gpt-4o",
		Tools:  []ports.ToolSpec{{Name: "list_tables", Description: "list", Schema: map[string]any{"type": "object"}}},
		Messages: []ports.LLMMessage{
			{Role: ports.RoleUser, Text: "hi"},
			{Role: ports.RoleAssistant, ToolName: "list_tables", ToolCallID: "c1", ToolArgs: map[string]any{}},
			{Role: ports.RoleTool, ToolCallID: "c1", ToolName: "list_tables", Text: `["users"]`},
		},
	}
	body := BuildOpenAIBody(req, 1024)
	if body["model"] != "gpt-4o" || body["stream"] != true {
		t.Fatalf("base fields wrong: %v", body)
	}
	tools, _ := body["tools"].([]map[string]any)
	if len(tools) != 1 || tools[0]["type"] != "function" {
		t.Fatalf("tools mapping wrong: %v", body["tools"])
	}
	msgs, _ := body["messages"].([]map[string]any)
	// system + user + assistant(tool_calls) + tool
	if len(msgs) != 4 || msgs[0]["role"] != "system" {
		t.Fatalf("messages wrong: %v", msgs)
	}
	if msgs[2]["role"] != "assistant" || msgs[2]["tool_calls"] == nil {
		t.Errorf("assistant tool_calls missing: %v", msgs[2])
	}
	if msgs[3]["role"] != "tool" || msgs[3]["tool_call_id"] != "c1" {
		t.Errorf("tool message wrong: %v", msgs[3])
	}
}

func TestOpenAIDecoderTextAndDone(t *testing.T) {
	d := NewOpenAIDecoder()
	var text strings.Builder
	var done bool
	for _, data := range []string{
		`{"choices":[{"delta":{"content":"Hel"}}]}`,
		`{"choices":[{"delta":{"content":"lo"}}]}`,
		`{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
		`[DONE]`,
	} {
		for _, e := range d.Line([]byte(data)) {
			if e.Kind == ports.EventText {
				text.WriteString(e.Text)
			}
			if e.Kind == ports.EventDone {
				done = true
			}
		}
	}
	if text.String() != "Hello" || !done {
		t.Fatalf("text=%q done=%v", text.String(), done)
	}
}

func TestOpenAIDecoderToolCall(t *testing.T) {
	d := NewOpenAIDecoder()
	var call *ports.ToolCall
	for _, data := range []string{
		`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"describe_table","arguments":""}}]}}]}`,
		`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"table\":"}}]}}]}`,
		`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"users\"}"}}]}}]}`,
		`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
	} {
		for _, e := range d.Line([]byte(data)) {
			if e.Kind == ports.EventToolCall {
				call = e.ToolCall
			}
		}
	}
	if call == nil || call.Name != "describe_table" || call.Args["table"] != "users" {
		t.Fatalf("tool call wrong: %+v", call)
	}
}

func TestOpenAIStatus(t *testing.T) {
	if s, _ := NewOpenAIProvider("", "", "").Status(nil); s.Ready {
		t.Error("no key should not be ready")
	}
	if s, _ := NewOpenAIProvider("sk-x", "", "").Status(nil); !s.Ready {
		t.Error("with key should be ready")
	}
}
