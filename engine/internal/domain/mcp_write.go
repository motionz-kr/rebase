package domain

import "time"

const (
	MCPWriteModeDisabled = "disabled"
	MCPWriteModeApproval = "approval_required"
	MCPWritePending      = "pending_approval"
	MCPWriteApproved     = "approved"
	MCPWriteRejected     = "rejected"
	MCPWriteExecuted     = "executed"
	MCPWriteFailed       = "failed"
)

func NormalizeMCPWriteMode(mode string) string {
	if mode == MCPWriteModeApproval {
		return MCPWriteModeApproval
	}
	return MCPWriteModeDisabled
}

// MCPWriteProposal is the durable hand-off between an external MCP process and
// the Rebase UI. SQL is retained locally so approval executes exactly what the
// client proposed; responses and activity records still redact credentials.
type MCPWriteProposal struct {
	ID           string     `json:"id"`
	WorkspaceID  string     `json:"workspaceId"`
	ProfileID    string     `json:"profileId"`
	SQL          string     `json:"sql"`
	Risk         string     `json:"risk"`
	Reasons      []string   `json:"reasons"`
	Status       string     `json:"status"`
	RowsAffected int64      `json:"rowsAffected"`
	Error        string     `json:"error,omitempty"`
	CreatedAt    time.Time  `json:"createdAt"`
	UpdatedAt    time.Time  `json:"updatedAt"`
	ApprovedAt   *time.Time `json:"approvedAt,omitempty"`
	ExecutedAt   *time.Time `json:"executedAt,omitempty"`
}
