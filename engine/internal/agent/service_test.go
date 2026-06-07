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
		emit(ports.LLMEvent{Kind: ports.EventToolCall, ToolCall: &ports.ToolCall{ID: "c1", Name: "describe_table", Args: map[string]any{"table": "users"}}})
		emit(ports.LLMEvent{Kind: ports.EventDone})
		return nil
	}
	// The assistant tool-use message must be replayed with its args so a
	// stateless provider can reconstruct the tool_use block.
	assistant := req.Messages[len(req.Messages)-2]
	if assistant.Role != ports.RoleAssistant || assistant.ToolName != "describe_table" || assistant.ToolArgs["table"] != "users" {
		emit(ports.LLMEvent{Kind: ports.EventError, Err: "assistant tool-use args not replayed"})
		emit(ports.LLMEvent{Kind: ports.EventDone})
		return nil
	}
	last := req.Messages[len(req.Messages)-1]
	if last.Role != ports.RoleTool || !strings.Contains(last.Text, "id") {
		emit(ports.LLMEvent{Kind: ports.EventError, Err: "tool result not fed back"})
		emit(ports.LLMEvent{Kind: ports.EventDone})
		return nil
	}
	emit(ports.LLMEvent{Kind: ports.EventText, Text: "There are 2 tables."})
	emit(ports.LLMEvent{Kind: ports.EventDone})
	return nil
}

func TestServiceRunsToolThenAnswers(t *testing.T) {
	reg := NewSQLRegistry(&fakeSQL{
		tables:  []ports.TableInfo{{Name: "users"}, {Name: "orders"}},
		columns: []ports.ColumnInfo{{Name: "id", Type: "int", PrimaryKey: true}},
	}, domainProfile(), "", "devdb")
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

// selectThenAnswer asks for run_select, then captures the fed-back tool result.
type selectThenAnswer struct {
	turn       int
	toolResult string
}

func (p *selectThenAnswer) Status(context.Context) (ports.ProviderStatus, error) {
	return ports.ProviderStatus{Ready: true}, nil
}
func (p *selectThenAnswer) Complete(_ context.Context, req ports.LLMRequest, emit func(ports.LLMEvent)) error {
	if p.turn == 0 {
		p.turn++
		emit(ports.LLMEvent{Kind: ports.EventToolCall, ToolCall: &ports.ToolCall{ID: "s1", Name: "run_select", Args: map[string]any{"sql": "SELECT * FROM users"}}})
		emit(ports.LLMEvent{Kind: ports.EventDone})
		return nil
	}
	p.toolResult = req.Messages[len(req.Messages)-1].Text
	emit(ports.LLMEvent{Kind: ports.EventText, Text: "done"})
	emit(ports.LLMEvent{Kind: ports.EventDone})
	return nil
}

func TestServiceDataExposureMetadataWithholdsRows(t *testing.T) {
	reg := NewSQLRegistry(&fakeSQL{}, domainProfile(), "", "devdb")
	prov := &selectThenAnswer{}
	svc := NewAgentService(prov, reg, 8)
	svc.SetPolicy(Policy{DataExposure: "metadata"})

	err := svc.Run(context.Background(), []ports.LLMMessage{{Role: ports.RoleUser, Text: "show users"}}, func(ports.LLMEvent) {})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if containsSubT(prov.toolResult, "alice") {
		t.Errorf("metadata policy must withhold row values, but result leaked them: %s", prov.toolResult)
	}
	if !containsSubT(prov.toolResult, "withheld") || !containsSubT(prov.toolResult, "rowCount") {
		t.Errorf("withheld result should carry a summary: %s", prov.toolResult)
	}
}

func TestServiceDataExposureUnrestrictedSendsRows(t *testing.T) {
	reg := NewSQLRegistry(&fakeSQL{}, domainProfile(), "", "devdb")
	prov := &selectThenAnswer{}
	svc := NewAgentService(prov, reg, 8) // default policy = unrestricted
	_ = svc.Run(context.Background(), []ports.LLMMessage{{Role: ports.RoleUser, Text: "show users"}}, func(ports.LLMEvent) {})
	if !containsSubT(prov.toolResult, "alice") {
		t.Errorf("unrestricted policy should pass row values, got: %s", prov.toolResult)
	}
}

func containsSubT(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// selfDrivingProv emits a tool_call (as claude would, via MCP) then a text
// answer, all in one Complete. It must be invoked exactly once.
type selfDrivingProv struct{ calls int }

func (p *selfDrivingProv) SelfDriving() bool { return true }
func (p *selfDrivingProv) Status(context.Context) (ports.ProviderStatus, error) {
	return ports.ProviderStatus{Ready: true}, nil
}
func (p *selfDrivingProv) Complete(_ context.Context, _ ports.LLMRequest, emit func(ports.LLMEvent)) error {
	p.calls++
	emit(ports.LLMEvent{Kind: ports.EventToolCall, ToolCall: &ports.ToolCall{ID: "x", Name: "mcp__rebase__list_tables"}})
	emit(ports.LLMEvent{Kind: ports.EventText, Text: "1 table: demo_users"})
	emit(ports.LLMEvent{Kind: ports.EventDone})
	return nil
}

func TestServiceSelfDrivingProviderRunsOnce(t *testing.T) {
	reg := NewSQLRegistry(&fakeSQL{}, domainProfile(), "", "devdb")
	prov := &selfDrivingProv{}
	svc := NewAgentService(prov, reg, 16)

	var text string
	var toolCalls int
	err := svc.Run(context.Background(), []ports.LLMMessage{{Role: ports.RoleUser, Text: "how many tables?"}}, func(e ports.LLMEvent) {
		if e.Kind == ports.EventText {
			text += e.Text
		}
		if e.Kind == ports.EventToolCall {
			toolCalls++
		}
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if prov.calls != 1 {
		t.Errorf("self-driving provider must be invoked exactly once, got %d", prov.calls)
	}
	if toolCalls != 1 {
		t.Errorf("expected the tool-use event forwarded once, got %d", toolCalls)
	}
	if text != "1 table: demo_users" {
		t.Errorf("answer = %q", text)
	}
}

// captureReq records the request the provider receives, to assert redaction.
type captureReq struct{ got ports.LLMRequest }

func (c *captureReq) Status(context.Context) (ports.ProviderStatus, error) {
	return ports.ProviderStatus{Ready: true}, nil
}
func (c *captureReq) Complete(_ context.Context, req ports.LLMRequest, emit func(ports.LLMEvent)) error {
	c.got = req
	emit(ports.LLMEvent{Kind: ports.EventDone})
	return nil
}

func TestServiceRedactsSecretsBeforeProvider(t *testing.T) {
	reg := NewSQLRegistry(&fakeSQL{}, domainProfile(), "", "devdb")
	prov := &captureReq{}
	svc := NewAgentService(prov, reg, 8)
	svc.SetSecrets([]string{"hunter2", "ref-xyz"})

	msg := ports.LLMMessage{Role: ports.RoleUser, Text: "my password is hunter2 and ref ref-xyz"}
	if err := svc.Run(context.Background(), []ports.LLMMessage{msg}, func(ports.LLMEvent) {}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	got := prov.got.Messages[len(prov.got.Messages)-1].Text
	if containsSubT(got, "hunter2") || containsSubT(got, "ref-xyz") {
		t.Errorf("secrets must be redacted before reaching the provider, got: %s", got)
	}
	if !containsSubT(got, "[redacted]") {
		t.Errorf("expected a redaction placeholder, got: %s", got)
	}
}

func TestServiceRedactIgnoresEmptySecret(t *testing.T) {
	reg := NewSQLRegistry(&fakeSQL{}, domainProfile(), "", "devdb")
	prov := &captureReq{}
	svc := NewAgentService(prov, reg, 8)
	svc.SetSecrets([]string{""}) // an empty secret must not blank the whole message
	msg := ports.LLMMessage{Role: ports.RoleUser, Text: "hello world"}
	_ = svc.Run(context.Background(), []ports.LLMMessage{msg}, func(ports.LLMEvent) {})
	if got := prov.got.Messages[0].Text; got != "hello world" {
		t.Errorf("empty secret must be a no-op, got: %q", got)
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

func TestServiceInjectsDomainContext(t *testing.T) {
	svc := NewAgentService(nil, nil, 16)
	base := svc.system
	svc.SetDomainContext("## 도메인 맥락\n- User (테이블) = 환자\n")

	req := svc.request([]ports.LLMMessage{{Role: "user", Text: "hi"}}, nil)
	if !strings.Contains(req.System, base) {
		t.Errorf("system should retain base prompt")
	}
	if !strings.Contains(req.System, "User (테이블) = 환자") {
		t.Errorf("system should include domain context, got:\n%s", req.System)
	}
}

func TestServiceNoDomainContextUnchanged(t *testing.T) {
	svc := NewAgentService(nil, nil, 16)
	req := svc.request([]ports.LLMMessage{{Role: "user", Text: "hi"}}, nil)
	if req.System != svc.system {
		t.Errorf("empty domain context must leave system unchanged")
	}
}
