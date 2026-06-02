package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

const defaultOpenAIBaseURL = "https://api.openai.com"

// OpenAIProvider implements ports.LLMProvider over the OpenAI Chat Completions
// API (streaming). Translation + SSE decoding are unit-tested; this type only
// does HTTP transport.
type OpenAIProvider struct {
	apiKey     string
	model      string
	baseURL    string
	maxTokens  int
	httpClient *http.Client
}

func NewOpenAIProvider(apiKey, model, baseURL string) *OpenAIProvider {
	if baseURL == "" {
		baseURL = defaultOpenAIBaseURL
	}
	if model == "" {
		model = "gpt-4o"
	}
	return &OpenAIProvider{
		apiKey:     apiKey,
		model:      model,
		baseURL:    strings.TrimRight(baseURL, "/"),
		maxTokens:  defaultMaxTokens,
		httpClient: &http.Client{Timeout: 120 * time.Second},
	}
}

func (o *OpenAIProvider) Status(_ context.Context) (ports.ProviderStatus, error) {
	if o.apiKey == "" {
		return ports.ProviderStatus{Ready: false, Detail: "no API key set"}, nil
	}
	return ports.ProviderStatus{Ready: true, Detail: "OpenAI API (" + o.model + ")"}, nil
}

func (o *OpenAIProvider) Complete(ctx context.Context, req ports.LLMRequest, emit func(ports.LLMEvent)) error {
	if req.Model == "" {
		req.Model = o.model
	}
	payload, err := json.Marshal(BuildOpenAIBody(req, o.maxTokens))
	if err != nil {
		return err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, o.baseURL+"/v1/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("accept", "text/event-stream")
	httpReq.Header.Set("authorization", "Bearer "+o.apiKey)

	resp, err := o.httpClient.Do(httpReq)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("openai API %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return parseOpenAISSE(resp.Body, emit)
}

// BuildOpenAIBody maps a neutral LLMRequest to the Chat Completions request body.
func BuildOpenAIBody(req ports.LLMRequest, maxTokens int) map[string]any {
	msgs := make([]map[string]any, 0, len(req.Messages)+1)
	if req.System != "" {
		msgs = append(msgs, map[string]any{"role": "system", "content": req.System})
	}
	for _, m := range req.Messages {
		switch m.Role {
		case ports.RoleUser:
			msgs = append(msgs, map[string]any{"role": "user", "content": m.Text})
		case ports.RoleAssistant:
			if m.ToolName != "" {
				input := m.ToolArgs
				if input == nil {
					input = map[string]any{}
				}
				argsJSON, _ := json.Marshal(input)
				msgs = append(msgs, map[string]any{
					"role": "assistant",
					"tool_calls": []map[string]any{{
						"id":       m.ToolCallID,
						"type":     "function",
						"function": map[string]any{"name": m.ToolName, "arguments": string(argsJSON)},
					}},
				})
			} else {
				msgs = append(msgs, map[string]any{"role": "assistant", "content": m.Text})
			}
		case ports.RoleTool:
			msgs = append(msgs, map[string]any{"role": "tool", "tool_call_id": m.ToolCallID, "content": m.Text})
		}
	}

	body := map[string]any{
		"model":      req.Model,
		"messages":   msgs,
		"stream":     true,
		"max_tokens": maxTokens,
	}
	if len(req.Tools) > 0 {
		tools := make([]map[string]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			schema := t.Schema
			if schema == nil {
				schema = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			tools = append(tools, map[string]any{
				"type":     "function",
				"function": map[string]any{"name": t.Name, "description": t.Description, "parameters": schema},
			})
		}
		body["tools"] = tools
	}
	return body
}

type oaToolAccum struct {
	id   string
	name string
	args []byte
}

// OpenAIDecoder converts Chat Completions stream chunks to neutral events,
// accumulating tool-call argument fragments by their index.
type OpenAIDecoder struct {
	calls map[int]*oaToolAccum
	order []int
}

func NewOpenAIDecoder() *OpenAIDecoder { return &OpenAIDecoder{calls: map[int]*oaToolAccum{}} }

func (d *OpenAIDecoder) flushToolCalls() []ports.LLMEvent {
	var out []ports.LLMEvent
	for _, idx := range d.order {
		c := d.calls[idx]
		args := map[string]any{}
		if len(c.args) > 0 {
			_ = json.Unmarshal(c.args, &args)
		}
		out = append(out, ports.LLMEvent{Kind: ports.EventToolCall, ToolCall: &ports.ToolCall{ID: c.id, Name: c.name, Args: args}})
	}
	d.calls = map[int]*oaToolAccum{}
	d.order = nil
	return out
}

// Line handles one SSE `data:` payload ("[DONE]" or a chunk JSON).
func (d *OpenAIDecoder) Line(data []byte) []ports.LLMEvent {
	if string(data) == "[DONE]" {
		return append(d.flushToolCalls(), ports.LLMEvent{Kind: ports.EventDone})
	}
	var chunk struct {
		Choices []struct {
			Delta struct {
				Content   string `json:"content"`
				ToolCalls []struct {
					Index    int    `json:"index"`
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"delta"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(data, &chunk); err != nil || len(chunk.Choices) == 0 {
		return nil
	}
	ch := chunk.Choices[0]
	var out []ports.LLMEvent
	if ch.Delta.Content != "" {
		out = append(out, ports.LLMEvent{Kind: ports.EventText, Text: ch.Delta.Content})
	}
	for _, tc := range ch.Delta.ToolCalls {
		c := d.calls[tc.Index]
		if c == nil {
			c = &oaToolAccum{}
			d.calls[tc.Index] = c
			d.order = append(d.order, tc.Index)
		}
		if tc.ID != "" {
			c.id = tc.ID
		}
		if tc.Function.Name != "" {
			c.name = tc.Function.Name
		}
		c.args = append(c.args, tc.Function.Arguments...)
	}
	if ch.FinishReason == "tool_calls" {
		out = append(out, d.flushToolCalls()...)
	}
	return out
}

func parseOpenAISSE(r io.Reader, emit func(ports.LLMEvent)) error {
	dec := NewOpenAIDecoder()
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(line[len("data:"):])
		if data == "" {
			continue
		}
		for _, e := range dec.Line([]byte(data)) {
			emit(e)
		}
	}
	return sc.Err()
}
