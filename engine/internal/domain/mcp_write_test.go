package domain

import "testing"

func TestNormalizeMCPWriteModeDefaultsToDisabled(t *testing.T) {
	if got := NormalizeMCPWriteMode(""); got != MCPWriteModeDisabled {
		t.Fatalf("empty mode = %q, want %q", got, MCPWriteModeDisabled)
	}
	if got := NormalizeMCPWriteMode("unknown"); got != MCPWriteModeDisabled {
		t.Fatalf("unknown mode = %q, want %q", got, MCPWriteModeDisabled)
	}
	if got := NormalizeMCPWriteMode(MCPWriteModeApproval); got != MCPWriteModeApproval {
		t.Fatalf("approval mode = %q, want %q", got, MCPWriteModeApproval)
	}
}

func TestNormalizeMCPWriteModeAllowsFullAccess(t *testing.T) {
	if got := NormalizeMCPWriteMode(MCPWriteModeFullAccess); got != MCPWriteModeFullAccess {
		t.Fatalf("full access mode = %q, want %q", got, MCPWriteModeFullAccess)
	}
}
