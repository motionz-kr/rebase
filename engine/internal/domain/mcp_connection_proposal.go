package domain

import (
	"fmt"
	"net"
	"strings"
	"time"
)

const (
	MCPConnectionProposalCreate   = "create"
	MCPConnectionProposalUpdate   = "update"
	MCPConnectionProposalPending  = "pending_approval"
	MCPConnectionProposalApplied  = "applied"
	MCPConnectionProposalRejected = "rejected"
)

// MCPConnectionProposal contains only non-secret connection details. It cannot
// carry credentials or grant MCP/database permissions.
type MCPConnectionProposal struct {
	ID              string     `json:"id"`
	WorkspaceID     string     `json:"workspaceId"`
	Operation       string     `json:"operation"`
	TargetProfileID string     `json:"targetProfileId,omitempty"`
	ResultProfileID string     `json:"resultProfileId,omitempty"`
	TargetUpdatedAt *time.Time `json:"targetUpdatedAt,omitempty"`
	CandidateID     string     `json:"candidateId"`
	Name            string     `json:"name"`
	Driver          string     `json:"driver"`
	Host            string     `json:"host"`
	Port            int        `json:"port"`
	Database        string     `json:"database,omitempty"`
	Username        string     `json:"username,omitempty"`
	TLSMode         string     `json:"tlsMode"`
	Source          string     `json:"source"`
	SourceName      string     `json:"sourceName,omitempty"`
	Status          string     `json:"status"`
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
}

func (p MCPConnectionProposal) Validate() error {
	if p.ID == "" || p.WorkspaceID == "" {
		return fmt.Errorf("proposal id and workspace are required")
	}
	if p.Operation != MCPConnectionProposalCreate && p.Operation != MCPConnectionProposalUpdate {
		return fmt.Errorf("unsupported connection proposal operation")
	}
	if p.Operation == MCPConnectionProposalUpdate && p.TargetProfileID == "" {
		return fmt.Errorf("target profile is required for an update proposal")
	}
	if p.Operation == MCPConnectionProposalUpdate && p.TargetUpdatedAt == nil {
		return fmt.Errorf("target profile revision is required for an update proposal")
	}
	if p.Operation == MCPConnectionProposalCreate && p.TargetProfileID != "" {
		return fmt.Errorf("create proposal cannot target an existing profile")
	}
	if p.Operation == MCPConnectionProposalCreate && p.ResultProfileID == "" {
		return fmt.Errorf("create proposal must reserve a result profile id")
	}
	if p.Operation == MCPConnectionProposalUpdate && p.ResultProfileID != "" {
		return fmt.Errorf("update proposal cannot reserve a new profile id")
	}
	if strings.TrimSpace(p.Name) == "" {
		return fmt.Errorf("connection profile name is required")
	}
	if p.Driver != "mysql" && p.Driver != "postgres" && p.Driver != "sqlserver" {
		return fmt.Errorf("unsupported database driver: %s", p.Driver)
	}
	ip := net.ParseIP(p.Host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("connection proposals only allow loopback hosts")
	}
	if p.Port < 1 || p.Port > 65535 || p.CandidateID != CandidateID(p.Driver, p.Host, p.Port) {
		return fmt.Errorf("proposal endpoint does not match its discovered candidate")
	}
	if p.Source != "local" && p.Source != "docker" {
		return fmt.Errorf("invalid connection proposal source")
	}
	if p.TLSMode != "none" && p.TLSMode != "prefer" && p.TLSMode != "require" {
		return fmt.Errorf("invalid TLS mode")
	}
	if p.Status != MCPConnectionProposalPending && p.Status != MCPConnectionProposalApplied && p.Status != MCPConnectionProposalRejected {
		return fmt.Errorf("invalid connection proposal status")
	}
	return nil
}
