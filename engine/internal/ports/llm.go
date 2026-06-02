package ports

import "context"

type LLMRole string

const (
	RoleUser      LLMRole = "user"
	RoleAssistant LLMRole = "assistant"
	RoleTool      LLMRole = "tool"
)

// LLMMessage is one turn in the conversation.
//   - RoleAssistant with ToolName/ToolCallID/ToolArgs represents the model's
//     tool-use request (kept so stateless providers can replay it each turn).
//   - RoleTool with ToolCallID/ToolName carries the tool result JSON in Text.
type LLMMessage struct {
	Role       LLMRole        `json:"role"`
	Text       string         `json:"text"`
	ToolCallID string         `json:"toolCallId,omitempty"`
	ToolName   string         `json:"toolName,omitempty"`
	ToolArgs   map[string]any `json:"toolArgs,omitempty"`
}

// ToolSpec is the schema advertised to the model.
type ToolSpec struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Schema      map[string]any `json:"schema"` // JSON Schema for the parameters object
}

// ToolCall is a model request to run a tool.
type ToolCall struct {
	ID   string         `json:"id"`
	Name string         `json:"name"`
	Args map[string]any `json:"args"`
}

type LLMRequest struct {
	System   string       `json:"system"`
	Messages []LLMMessage `json:"messages"`
	Tools    []ToolSpec   `json:"tools"`
	Model    string       `json:"model"`
}

type LLMEventKind string

const (
	EventText     LLMEventKind = "text"      // incremental assistant text
	EventToolCall LLMEventKind = "tool_call" // model wants to run a tool
	EventDone     LLMEventKind = "done"      // turn complete
	EventError    LLMEventKind = "error"
)

type LLMEvent struct {
	Kind     LLMEventKind `json:"kind"`
	Text     string       `json:"text,omitempty"`
	ToolCall *ToolCall    `json:"toolCall,omitempty"`
	Err      string       `json:"err,omitempty"`
}

type ProviderStatus struct {
	Ready  bool   `json:"ready"`
	Detail string `json:"detail"`
}

// LLMProvider streams a completion. Implementations translate LLMRequest to/from
// their wire format and call emit for each event. Returning an error means a
// transport-level failure (an in-band model error is emitted as EventError).
type LLMProvider interface {
	Complete(ctx context.Context, req LLMRequest, emit func(LLMEvent)) error
	Status(ctx context.Context) (ProviderStatus, error)
}
