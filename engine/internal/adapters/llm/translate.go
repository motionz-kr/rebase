package llm

import (
	"encoding/json"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// BuildAnthropicBody maps a neutral LLMRequest to the Anthropic Messages API
// request body. Tool results (RoleTool) become user messages carrying a
// tool_result block; assistant tool-use turns are replayed as tool_use blocks.
func BuildAnthropicBody(req ports.LLMRequest, maxTokens int) map[string]any {
	tools := make([]map[string]any, 0, len(req.Tools))
	for _, t := range req.Tools {
		schema := t.Schema
		if schema == nil {
			schema = map[string]any{"type": "object", "properties": map[string]any{}}
		}
		tools = append(tools, map[string]any{
			"name":         t.Name,
			"description":  t.Description,
			"input_schema": schema,
		})
	}

	msgs := make([]map[string]any, 0, len(req.Messages))
	for _, m := range req.Messages {
		switch m.Role {
		case ports.RoleUser:
			msgs = append(msgs, map[string]any{
				"role":    "user",
				"content": []map[string]any{{"type": "text", "text": m.Text}},
			})
		case ports.RoleAssistant:
			if m.ToolName != "" {
				input := m.ToolArgs
				if input == nil {
					input = map[string]any{}
				}
				msgs = append(msgs, map[string]any{
					"role":    "assistant",
					"content": []map[string]any{{"type": "tool_use", "id": m.ToolCallID, "name": m.ToolName, "input": input}},
				})
			} else {
				msgs = append(msgs, map[string]any{
					"role":    "assistant",
					"content": []map[string]any{{"type": "text", "text": m.Text}},
				})
			}
		case ports.RoleTool:
			msgs = append(msgs, map[string]any{
				"role":    "user",
				"content": []map[string]any{{"type": "tool_result", "tool_use_id": m.ToolCallID, "content": m.Text}},
			})
		}
	}

	body := map[string]any{
		"model":      req.Model,
		"max_tokens": maxTokens,
		"stream":     true,
		"messages":   msgs,
	}
	if req.System != "" {
		body["system"] = req.System
	}
	if len(tools) > 0 {
		body["tools"] = tools
	}
	return body
}

// StreamDecoder converts Anthropic SSE events into neutral LLMEvents. It is
// stateful across events to accumulate a tool_use block's streamed JSON input.
type StreamDecoder struct {
	toolActive  bool
	toolID      string
	toolName    string
	toolJSONBuf []byte
}

func NewStreamDecoder() *StreamDecoder { return &StreamDecoder{} }

// Event handles one SSE event (the `event:` type and its `data:` JSON payload)
// and returns zero or more neutral events.
func (d *StreamDecoder) Event(event string, data []byte) []ports.LLMEvent {
	switch event {
	case "content_block_start":
		var p struct {
			ContentBlock struct {
				Type string `json:"type"`
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"content_block"`
		}
		_ = json.Unmarshal(data, &p)
		if p.ContentBlock.Type == "tool_use" {
			d.toolActive = true
			d.toolID = p.ContentBlock.ID
			d.toolName = p.ContentBlock.Name
			d.toolJSONBuf = d.toolJSONBuf[:0]
		}
		return nil

	case "content_block_delta":
		var p struct {
			Delta struct {
				Type        string `json:"type"`
				Text        string `json:"text"`
				PartialJSON string `json:"partial_json"`
			} `json:"delta"`
		}
		_ = json.Unmarshal(data, &p)
		switch p.Delta.Type {
		case "text_delta":
			if p.Delta.Text == "" {
				return nil
			}
			return []ports.LLMEvent{{Kind: ports.EventText, Text: p.Delta.Text}}
		case "input_json_delta":
			d.toolJSONBuf = append(d.toolJSONBuf, p.Delta.PartialJSON...)
		}
		return nil

	case "content_block_stop":
		if !d.toolActive {
			return nil
		}
		d.toolActive = false
		args := map[string]any{}
		if len(d.toolJSONBuf) > 0 {
			_ = json.Unmarshal(d.toolJSONBuf, &args)
		}
		return []ports.LLMEvent{{Kind: ports.EventToolCall, ToolCall: &ports.ToolCall{ID: d.toolID, Name: d.toolName, Args: args}}}

	case "message_stop":
		return []ports.LLMEvent{{Kind: ports.EventDone}}

	case "error":
		var p struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(data, &p)
		msg := p.Error.Message
		if msg == "" {
			msg = "stream error"
		}
		return []ports.LLMEvent{{Kind: ports.EventError, Err: msg}}
	}
	return nil
}
