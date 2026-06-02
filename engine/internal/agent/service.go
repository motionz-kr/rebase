package agent

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// Policy controls what tool output is allowed back into the model context.
type Policy struct {
	// DataExposure: "unrestricted" (default), "on_request", or "metadata".
	// Under metadata/on_request, row values from data tools are withheld and
	// replaced with a column/row-count summary.
	DataExposure string
}

type AgentService struct {
	provider ports.LLMProvider
	registry *Registry
	maxSteps int
	system   string
	policy   Policy
}

func NewAgentService(p ports.LLMProvider, reg *Registry, maxSteps int) *AgentService {
	if maxSteps <= 0 {
		maxSteps = 16
	}
	return &AgentService{provider: p, registry: reg, maxSteps: maxSteps,
		system: "You are a database assistant. Use the provided tools to inspect the schema and answer precisely. " +
			"To change data or schema, call propose_write — never claim a change was applied unless the user ran it."}
}

// SetPolicy configures the data-exposure gate (default: unrestricted).
func (s *AgentService) SetPolicy(p Policy) { s.policy = p }

// dataTools produce row values that the data-exposure policy may withhold.
var dataTools = map[string]bool{"run_select": true, "explain_query": true, "profile_table": true}

func sanitizeForPolicy(toolName string, result any, p Policy) any {
	if p.DataExposure == "" || p.DataExposure == "unrestricted" || !dataTools[toolName] {
		return result
	}
	if qr, ok := result.(queryResult); ok {
		return map[string]any{
			"withheld": true,
			"reason":   "data-exposure policy (" + p.DataExposure + "): row values are not sent to the model",
			"columns":  qr.Columns,
			"rowCount": qr.RowCount,
		}
	}
	return result
}

// Run drives the agent loop, forwarding text + tool events to emit. It returns
// an error if the loop exceeds maxSteps or the provider/tool dispatch fails
// fatally.
func (s *AgentService) Run(ctx context.Context, conversation []ports.LLMMessage, emit func(ports.LLMEvent)) error {
	messages := append([]ports.LLMMessage(nil), conversation...)
	specs := s.registry.Specs()

	// Self-driving providers (e.g. the local CLI, which runs its own agent loop
	// and calls our tools over MCP) own the loop entirely: invoke once and stream
	// their events through. Re-dispatching their tool calls here would run the
	// provider again per tool use — an accidental multi-call loop.
	if sd, ok := s.provider.(interface{ SelfDriving() bool }); ok && sd.SelfDriving() {
		req := ports.LLMRequest{System: s.system, Messages: messages, Tools: specs}
		return s.provider.Complete(ctx, req, emit)
	}

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
			b, _ := json.Marshal(sanitizeForPolicy(pending.Name, result, s.policy))
			payload = string(b)
		}
		messages = append(messages,
			ports.LLMMessage{Role: ports.RoleAssistant, ToolName: pending.Name, ToolCallID: pending.ID, ToolArgs: pending.Args},
			ports.LLMMessage{Role: ports.RoleTool, ToolCallID: pending.ID, ToolName: pending.Name, Text: payload},
		)
	}
	return fmt.Errorf("agent exceeded max steps (%d)", s.maxSteps)
}
