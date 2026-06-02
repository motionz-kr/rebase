package agent

import (
	"context"
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// fakeProvider emits scripted turns: turn 0 asks for list_tables, turn 1 answers.
type fakeProvider struct{ turn int }

func (f *fakeProvider) Status(context.Context) (ports.ProviderStatus, error) {
	return ports.ProviderStatus{Ready: true}, nil
}
func (f *fakeProvider) Complete(_ context.Context, req ports.LLMRequest, emit func(ports.LLMEvent)) error {
	if f.turn == 0 {
		f.turn++
		emit(ports.LLMEvent{Kind: ports.EventToolCall, ToolCall: &ports.ToolCall{ID: "c1", Name: "list_tables", Args: map[string]any{}}})
		emit(ports.LLMEvent{Kind: ports.EventDone})
		return nil
	}
	last := req.Messages[len(req.Messages)-1]
	if last.Role != ports.RoleTool || !strings.Contains(last.Text, "users") {
		emit(ports.LLMEvent{Kind: ports.EventError, Err: "tool result not fed back"})
		emit(ports.LLMEvent{Kind: ports.EventDone})
		return nil
	}
	emit(ports.LLMEvent{Kind: ports.EventText, Text: "There are 2 tables."})
	emit(ports.LLMEvent{Kind: ports.EventDone})
	return nil
}

func TestServiceRunsToolThenAnswers(t *testing.T) {
	reg := NewSQLRegistry(&fakeSQL{tables: []ports.TableInfo{{Name: "users"}, {Name: "orders"}}},
		domainProfile(), "", "devdb")
	svc := NewAgentService(&fakeProvider{}, reg, 8)

	var text strings.Builder
	var toolCalls int
	err := svc.Run(context.Background(), []ports.LLMMessage{{Role: ports.RoleUser, Text: "how many tables?"}},
		func(e ports.LLMEvent) {
			switch e.Kind {
			case ports.EventText:
				text.WriteString(e.Text)
			case ports.EventToolCall:
				toolCalls++
			}
		})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if toolCalls != 1 {
		t.Errorf("expected 1 tool call, got %d", toolCalls)
	}
	if !strings.Contains(text.String(), "2 tables") {
		t.Errorf("final answer = %q, want it to mention '2 tables'", text.String())
	}
}

type loopingProvider struct{}

func (loopingProvider) Status(context.Context) (ports.ProviderStatus, error) {
	return ports.ProviderStatus{Ready: true}, nil
}
func (loopingProvider) Complete(_ context.Context, _ ports.LLMRequest, emit func(ports.LLMEvent)) error {
	emit(ports.LLMEvent{Kind: ports.EventToolCall, ToolCall: &ports.ToolCall{ID: "x", Name: "list_tables"}})
	emit(ports.LLMEvent{Kind: ports.EventDone})
	return nil
}

func TestServiceMaxSteps(t *testing.T) {
	reg := NewSQLRegistry(&fakeSQL{}, domainProfile(), "", "devdb")
	svc := NewAgentService(loopingProvider{}, reg, 3)
	steps := 0
	err := svc.Run(context.Background(), []ports.LLMMessage{{Role: ports.RoleUser, Text: "x"}},
		func(e ports.LLMEvent) {
			if e.Kind == ports.EventToolCall {
				steps++
			}
		})
	if err == nil {
		t.Fatal("expected a max-steps error")
	}
	if steps > 3 {
		t.Errorf("ran %d steps, should stop at maxSteps=3", steps)
	}
}
