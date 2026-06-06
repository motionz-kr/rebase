package http

import "testing"

func TestEvaluateGate(t *testing.T) {
	// read-only profile blocks any write regardless of allowWrite
	g := evaluateGate(gateInput{readOnlyProfile: true, classReadOnly: false, allowWrite: true})
	if g.code != "read_only_blocked" {
		t.Errorf("read-only profile must block write, got %q", g.code)
	}
	// safe mode + high risk + not acknowledged -> ack required
	g = evaluateGate(gateInput{safeMode: true, riskHigh: true, allowWrite: true, confirmDestructive: true, acknowledged: false})
	if g.code != "acknowledgement_required" {
		t.Errorf("safe-mode high risk must require ack, got %q", g.code)
	}
	// safe mode + high + acknowledged -> pass
	g = evaluateGate(gateInput{safeMode: true, riskHigh: true, allowWrite: true, confirmDestructive: true, acknowledged: true})
	if g.code != "" {
		t.Errorf("acknowledged should pass, got %q", g.code)
	}
	// normal mode unchanged: destructive needs confirm
	g = evaluateGate(gateInput{classDestructive: true, allowWrite: true, confirmDestructive: false})
	if g.code != "confirmation_required" {
		t.Errorf("destructive needs confirm, got %q", g.code)
	}
	// plain read-only select passes
	g = evaluateGate(gateInput{classReadOnly: true})
	if g.code != "" {
		t.Errorf("read-only select should pass, got %q", g.code)
	}
}
