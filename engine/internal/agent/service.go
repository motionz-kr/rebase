package agent

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type AgentService struct {
	provider ports.LLMProvider
	registry *Registry
	maxSteps int
	system   string
}

func NewAgentService(p ports.LLMProvider, reg *Registry, maxSteps int) *AgentService {
	if maxSteps <= 0 {
		maxSteps = 16
	}
	return &AgentService{provider: p, registry: reg, maxSteps: maxSteps,
		system: "You are a database assistant. Use the provided tools to inspect the schema and answer precisely."}
}

// Run drives the agent loop, forwarding text + tool events to emit. It returns
// an error if the loop exceeds maxSteps or the provider/tool dispatch fails
// fatally.
func (s *AgentService) Run(ctx context.Context, conversation []ports.LLMMessage, emit func(ports.LLMEvent)) error {
	messages := append([]ports.LLMMessage(nil), conversation...)
	specs := s.registry.Specs()

	for step := 0; step < s.maxSteps; step++ {
		if err := ctx.Err(); err != nil {
			return err
		}

		var pending *ports.ToolCall
		req := ports.LLMRequest{System: s.system, Messages: messages, Tools: specs}
		err := s.provider.Complete(ctx, req, func(e ports.LLMEvent) {
			if e.Kind == ports.EventToolCall && e.ToolCall != nil {
				pending = e.ToolCall // dispatch after the turn completes
			}
			emit(e)
		})
		if err != nil {
			return err
		}

		if pending == nil {
			return nil // model produced a final answer
		}

		result, derr := s.registry.Dispatch(ctx, pending.Name, pending.Args)
		var payload string
		if derr != nil {
			payload = fmt.Sprintf(`{"error":%q}`, derr.Error())
		} else {
			b, _ := json.Marshal(result)
			payload = string(b)
		}
		messages = append(messages,
			ports.LLMMessage{Role: ports.RoleAssistant, ToolName: pending.Name, ToolCallID: pending.ID},
			ports.LLMMessage{Role: ports.RoleTool, ToolCallID: pending.ID, ToolName: pending.Name, Text: payload},
		)
	}
	return fmt.Errorf("agent exceeded max steps (%d)", s.maxSteps)
}
