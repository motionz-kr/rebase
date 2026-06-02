package llm

import (
	"encoding/json"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

func TestBuildAnthropicBody(t *testing.T) {
	req := ports.LLMRequest{
		System: "you are a db assistant",
		Model:  "claude-sonnet-4-6",
		Tools: []ports.ToolSpec{{
			Name:        "list_tables",
			Description: "list tables",
			Schema:      map[string]any{"type": "object", "properties": map[string]any{}},
		}},
		Messages: []ports.LLMMessage{
			{Role: ports.RoleUser, Text: "how many tables?"},
			{Role: ports.RoleAssistant, ToolName: "list_tables", ToolCallID: "c1", ToolArgs: map[string]any{}},
			{Role: ports.RoleTool, ToolCallID: "c1", ToolName: "list_tables", Text: `["users"]`},
		},
	}
	body := BuildAnthropicBody(req, 1024)

	if body["system"] != "you are a db assistant" || body["model"] != "claude-sonnet-4-6" {
		t.Fatalf("system/model not mapped: %v", body)
	}
	if body["stream"] != true {
		t.Errorf("stream should be true")
	}
	// Tools → input_schema
	tools, _ := body["tools"].([]map[string]any)
	if len(tools) != 1 || tools[0]["name"] != "list_tables" || tools[0]["input_schema"] == nil {
		t.Fatalf("tools not mapped: %v", body["tools"])
	}
	// Messages: user, assistant(tool_use), user(tool_result)
	msgs, _ := body["messages"].([]map[string]any)
	if len(msgs) != 3 {
		t.Fatalf("want 3 messages, got %d: %v", len(msgs), msgs)
	}
	if msgs[0]["role"] != "user" {
		t.Errorf("msg0 role = %v", msgs[0]["role"])
	}
	if msgs[1]["role"] != "assistant" {
		t.Errorf("msg1 role = %v", msgs[1]["role"])
	}
	// assistant content must include a tool_use block carrying id+name
	ac, _ := msgs[1]["content"].([]map[string]any)
	if len(ac) != 1 || ac[0]["type"] != "tool_use" || ac[0]["id"] != "c1" || ac[0]["name"] != "list_tables" {
		t.Errorf("assistant tool_use block wrong: %v", msgs[1]["content"])
	}
	// tool result becomes a user message with a tool_result block
	if msgs[2]["role"] != "user" {
		t.Errorf("msg2 (tool result) role = %v, want user", msgs[2]["role"])
	}
	tc, _ := msgs[2]["content"].([]map[string]any)
	if len(tc) != 1 || tc[0]["type"] != "tool_result" || tc[0]["tool_use_id"] != "c1" {
		t.Errorf("tool_result block wrong: %v", msgs[2]["content"])
	}
}

// feed is a helper to drive the decoder with a JSON object as the SSE data.
func feed(d *StreamDecoder, event string, obj any) []ports.LLMEvent {
	b, _ := json.Marshal(obj)
	return d.Event(event, b)
}

func TestStreamDecoderTextAndDone(t *testing.T) {
	d := NewStreamDecoder()
	var got []ports.LLMEvent
	got = append(got, feed(d, "message_start", map[string]any{})...)
	got = append(got, feed(d, "content_block_start", map[string]any{"index": 0, "content_block": map[string]any{"type": "text"}})...)
	got = append(got, feed(d, "content_block_delta", map[string]any{"index": 0, "delta": map[string]any{"type": "text_delta", "text": "Hello"}})...)
	got = append(got, feed(d, "content_block_delta", map[string]any{"index": 0, "delta": map[string]any{"type": "text_delta", "text": " world"}})...)
	got = append(got, feed(d, "content_block_stop", map[string]any{"index": 0})...)
	got = append(got, feed(d, "message_stop", map[string]any{})...)

	var text string
	var done bool
	for _, e := range got {
		switch e.Kind {
		case ports.EventText:
			text += e.Text
		case ports.EventDone:
			done = true
		}
	}
	if text != "Hello world" {
		t.Errorf("text = %q, want 'Hello world'", text)
	}
	if !done {
		t.Errorf("expected an EventDone")
	}
}

func TestStreamDecoderToolUse(t *testing.T) {
	d := NewStreamDecoder()
	var got []ports.LLMEvent
	got = append(got, feed(d, "content_block_start", map[string]any{"index": 0, "content_block": map[string]any{"type": "tool_use", "id": "t1", "name": "describe_table"}})...)
	got = append(got, feed(d, "content_block_delta", map[string]any{"index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": `{"table":`}})...)
	got = append(got, feed(d, "content_block_delta", map[string]any{"index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": `"users"}`}})...)
	got = append(got, feed(d, "content_block_stop", map[string]any{"index": 0})...)

	var call *ports.ToolCall
	for _, e := range got {
		if e.Kind == ports.EventToolCall {
			call = e.ToolCall
		}
	}
	if call == nil {
		t.Fatal("expected an EventToolCall")
	}
	if call.ID != "t1" || call.Name != "describe_table" || call.Args["table"] != "users" {
		t.Errorf("tool call wrong: %+v", call)
	}
}

func TestStreamDecoderError(t *testing.T) {
	d := NewStreamDecoder()
	got := feed(d, "error", map[string]any{"error": map[string]any{"message": "overloaded"}})
	if len(got) != 1 || got[0].Kind != ports.EventError || got[0].Err == "" {
		t.Fatalf("expected EventError, got %+v", got)
	}
}
