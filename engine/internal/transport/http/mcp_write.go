package http

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/smlee/database-local-engine/engine/internal/adapters/mysql"
	"github.com/smlee/database-local-engine/engine/internal/adapters/postgres"
	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlite"
	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlserver"
	"github.com/smlee/database-local-engine/engine/internal/agent"
	"github.com/smlee/database-local-engine/engine/internal/application"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type MCPWriteHandler struct {
	token     string
	service   *application.ConnectionService
	proposals ports.MCPWriteProposalRepository
	activity  ports.MCPActivityRepository
	mysql     *mysql.MySQLConnector
	postgres  *postgres.PostgreSQLConnector
	sqlite    *sqlite.SQLiteConnector
	sqlserver *sqlserver.SQLServerConnector
}

func NewMCPWriteHandler(token string, service *application.ConnectionService, proposals ports.MCPWriteProposalRepository, activity ports.MCPActivityRepository) *MCPWriteHandler {
	return &MCPWriteHandler{
		token: token, service: service, proposals: proposals, activity: activity,
		mysql: mysql.NewMySQLConnector(), postgres: postgres.NewPostgreSQLConnector(),
		sqlite: sqlite.NewSQLiteConnector(), sqlserver: sqlserver.NewSQLServerConnector(),
	}
}

func (h *MCPWriteHandler) checkToken(r *http.Request) bool {
	return validToken(r.Header.Get("X-App-Engine-Token"), h.token)
}

func (h *MCPWriteHandler) connector(driver string) (ports.SQLConnector, error) {
	switch driver {
	case "mysql":
		return h.mysql, nil
	case "postgres":
		return h.postgres, nil
	case "sqlite":
		return h.sqlite, nil
	case "sqlserver":
		return h.sqlserver, nil
	default:
		return nil, fmtError("unsupported SQL driver for MCP write approval: " + driver)
	}
}

type mcpWriteProposalDTO struct {
	ID           string    `json:"id"`
	WorkspaceID  string    `json:"workspaceId"`
	ProfileID    string    `json:"profileId"`
	SQL          string    `json:"sql"`
	Risk         string    `json:"risk"`
	Reasons      []string  `json:"reasons"`
	Status       string    `json:"status"`
	RowsAffected int64     `json:"rowsAffected"`
	Error        string    `json:"error,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

func writeProposalDTO(p *domain.MCPWriteProposal) mcpWriteProposalDTO {
	return mcpWriteProposalDTO{ID: p.ID, WorkspaceID: p.WorkspaceID, ProfileID: p.ProfileID, SQL: p.SQL, Risk: p.Risk, Reasons: p.Reasons, Status: p.Status, RowsAffected: p.RowsAffected, Error: p.Error, CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt}
}

// Proposals exposes pending writes to the local Rebase UI and executes only a
// proposal explicitly approved by that UI.
func (h *MCPWriteHandler) Proposals() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		if h.proposals == nil {
			http.Error(w, "MCP write approvals are unavailable", http.StatusNotImplemented)
			return
		}
		workspaceID := r.URL.Query().Get("workspaceId")
		if workspaceID == "" {
			workspaceID = "default"
		}
		switch r.Method {
		case http.MethodGet:
			profileID := r.URL.Query().Get("profileId")
			status := r.URL.Query().Get("status")
			items, err := h.proposals.List(r.Context(), workspaceID, profileID, status, 100)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			out := make([]mcpWriteProposalDTO, len(items))
			for i := range items {
				out[i] = writeProposalDTO(&items[i])
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(out)
		case http.MethodPost:
			var body struct {
				ID     string `json:"id"`
				Action string `json:"action"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.ID) == "" {
				http.Error(w, "id and action are required", http.StatusBadRequest)
				return
			}
			var proposal *domain.MCPWriteProposal
			var err error
			if body.Action == "approve" {
				proposal, err = h.approve(r.Context(), workspaceID, body.ID)
			} else if body.Action == "reject" {
				proposal, err = h.reject(r.Context(), workspaceID, body.ID)
			} else {
				http.Error(w, "action must be approve or reject", http.StatusBadRequest)
				return
			}
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(writeProposalDTO(proposal))
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

func (h *MCPWriteHandler) reject(ctx context.Context, workspaceID, id string) (*domain.MCPWriteProposal, error) {
	proposal, err := h.proposals.Get(ctx, workspaceID, id)
	if err != nil || proposal == nil {
		return nil, fmtError("MCP write proposal not found")
	}
	if proposal.Status != domain.MCPWritePending {
		return nil, fmtError("MCP write proposal is already " + proposal.Status)
	}
	proposal.Status = domain.MCPWriteRejected
	proposal.UpdatedAt = time.Now().UTC()
	if err := h.proposals.Update(ctx, proposal); err != nil {
		return nil, err
	}
	return proposal, nil
}

func (h *MCPWriteHandler) approve(ctx context.Context, workspaceID, id string) (*domain.MCPWriteProposal, error) {
	proposal, err := h.proposals.Get(ctx, workspaceID, id)
	if err != nil || proposal == nil {
		return nil, fmtError("MCP write proposal not found")
	}
	if proposal.Status != domain.MCPWritePending {
		return nil, fmtError("MCP write proposal is already " + proposal.Status)
	}
	profile, password, err := h.service.GetProfile(ctx, proposal.ProfileID)
	if err != nil {
		return nil, err
	}
	if !profile.McpEnabled || domain.NormalizeMCPWriteMode(profile.McpWriteMode) != domain.MCPWriteModeApproval {
		return nil, fmtError("MCP write approval is disabled for this connection")
	}
	if profile.ReadOnly {
		return nil, fmtError("the connection is read-only")
	}
	conn, err := h.connector(profile.Driver)
	if err != nil {
		return nil, err
	}
	startedAt := time.Now()
	approvedAt := time.Now().UTC()
	proposal.Status = domain.MCPWriteApproved
	proposal.ApprovedAt = &approvedAt
	proposal.UpdatedAt = approvedAt
	_ = h.proposals.Update(ctx, proposal)
	rowsAffected, _, execErr := conn.ExecuteBatch(ctx, *profile, password, []string{proposal.SQL})
	proposal.RowsAffected = rowsAffected
	proposal.UpdatedAt = time.Now().UTC()
	if execErr != nil {
		proposal.Status = domain.MCPWriteFailed
		proposal.Error = domain.SafeMCPError(execErr.Error())
	} else {
		executedAt := proposal.UpdatedAt
		proposal.Status = domain.MCPWriteExecuted
		proposal.ExecutedAt = &executedAt
	}
	if err := h.proposals.Update(ctx, proposal); err != nil {
		return nil, err
	}
	if h.activity != nil {
		completedAt := time.Now()
		_ = h.activity.Append(ctx, &domain.MCPActivityEvent{
			ID: uuid.NewString(), WorkspaceID: workspaceID, ProfileID: proposal.ProfileID,
			Direction: "inbound", Event: "write_approval", Tool: "propose_write",
			Status: map[bool]string{true: "success", false: "error"}[execErr == nil],
			Error:  proposal.Error, QueryText: agent.Redact(proposal.SQL, []string{password, profile.SecretRef}),
			DurationMs: completedAt.Sub(startedAt).Milliseconds(), CreatedAt: proposal.UpdatedAt,
		})
	}
	if execErr != nil {
		return proposal, execErr
	}
	return proposal, nil
}
