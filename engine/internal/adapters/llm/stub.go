package llm

import (
	"context"
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// StubProvider is a deterministic, offline LLMProvider used for development and
// for end-to-end pipeline verification without a real model. It drives the agent
// loop: when asked about tables it requests list_tables, then answers from the
// tool result; otherwise it echoes.
type StubProvider struct{}

func NewStubProvider() *StubProvider { return &StubProvider{} }

func (s *StubProvider) Status(_ context.Context) (ports.ProviderStatus, error) {
	return ports.ProviderStatus{Ready: true, Detail: "stub (offline, no real model)"}, nil
}

func (s *StubProvider) Complete(_ context.Context, req ports.LLMRequest, emit func(ports.LLMEvent)) error {
	if len(req.Messages) == 0 {
		emit(ports.LLMEvent{Kind: ports.EventText, Text: "Stub agent ready."})
		emit(ports.LLMEvent{Kind: ports.EventDone})
		return nil
	}
	last := req.Messages[len(req.Messages)-1]

	// Answer from a tool result.
	if last.Role == ports.RoleTool {
		emit(ports.LLMEvent{Kind: ports.EventText, Text: "Here is what the tools returned: "})
		emit(ports.LLMEvent{Kind: ports.EventText, Text: last.Text})
		emit(ports.LLMEvent{Kind: ports.EventDone})
		return nil
	}

	trimmed := strings.TrimSpace(last.Text)
	upper := strings.ToUpper(trimmed)
	// If the user typed a raw write statement, route it through propose_write so
	// the approval gate is exercised (the stub never executes it itself).
	for _, kw := range []string{"INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "TRUNCATE"} {
		if strings.HasPrefix(upper, kw+" ") {
			emit(ports.LLMEvent{Kind: ports.EventToolCall, ToolCall: &ports.ToolCall{ID: "stub-write", Name: "propose_write", Args: map[string]any{"sql": trimmed}}})
			emit(ports.LLMEvent{Kind: ports.EventDone})
			return nil
		}
	}

	// Drive a read tool when the user asks about tables/schema.
	lower := strings.ToLower(last.Text)
	if strings.Contains(lower, "table") || strings.Contains(lower, "schema") {
		emit(ports.LLMEvent{Kind: ports.EventToolCall, ToolCall: &ports.ToolCall{ID: "stub-1", Name: "list_tables", Args: map[string]any{}}})
		emit(ports.LLMEvent{Kind: ports.EventDone})
		return nil
	}

	emit(ports.LLMEvent{Kind: ports.EventText, Text: "Stub agent (offline). Ask about your tables. You said: " + last.Text})
	emit(ports.LLMEvent{Kind: ports.EventDone})
	return nil
}
