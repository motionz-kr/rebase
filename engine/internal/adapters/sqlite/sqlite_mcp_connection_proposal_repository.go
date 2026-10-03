package sqlite

import (
	"context"
	"database/sql"
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type SQLiteMCPConnectionProposalRepository struct{ db *sql.DB }

func NewSQLiteMCPConnectionProposalRepository(db *sql.DB) *SQLiteMCPConnectionProposalRepository {
	return &SQLiteMCPConnectionProposalRepository{db: db}
}

func (r *SQLiteMCPConnectionProposalRepository) Create(ctx context.Context, proposal *domain.MCPConnectionProposal) error {
	var targetUpdatedAt any
	if proposal.TargetUpdatedAt != nil {
		targetUpdatedAt = *proposal.TargetUpdatedAt
	}
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO mcp_connection_proposals
		(id, workspace_id, operation, target_profile_id, result_profile_id, target_updated_at, candidate_id, name, driver, host, port, database_name, username, tls_mode, source, source_name, status, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, proposal.ID, proposal.WorkspaceID, proposal.Operation, proposal.TargetProfileID, proposal.ResultProfileID, targetUpdatedAt, proposal.CandidateID, proposal.Name, proposal.Driver, proposal.Host, proposal.Port, proposal.Database, proposal.Username, proposal.TLSMode, proposal.Source, proposal.SourceName, proposal.Status, proposal.CreatedAt, proposal.UpdatedAt)
	return err
}

func (r *SQLiteMCPConnectionProposalRepository) Get(ctx context.Context, workspaceID, id string) (*domain.MCPConnectionProposal, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, workspace_id, operation, target_profile_id, result_profile_id, target_updated_at, candidate_id, name, driver, host, port, database_name, username, tls_mode, source, source_name, status, created_at, updated_at
		FROM mcp_connection_proposals WHERE workspace_id = ? AND id = ? LIMIT 1
	`, workspaceID, id)
	proposal, err := scanMCPConnectionProposal(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return proposal, err
}

func (r *SQLiteMCPConnectionProposalRepository) List(ctx context.Context, workspaceID, status string, limit int) ([]domain.MCPConnectionProposal, error) {
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	query := strings.Builder{}
	query.WriteString(`SELECT id, workspace_id, operation, target_profile_id, result_profile_id, target_updated_at, candidate_id, name, driver, host, port, database_name, username, tls_mode, source, source_name, status, created_at, updated_at FROM mcp_connection_proposals WHERE workspace_id = ?`)
	args := []any{workspaceID}
	if status != "" {
		query.WriteString(" AND status = ?")
		args = append(args, status)
	}
	query.WriteString(" ORDER BY created_at DESC LIMIT ?")
	args = append(args, limit)
	rows, err := r.db.QueryContext(ctx, query.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.MCPConnectionProposal
	for rows.Next() {
		proposal, err := scanMCPConnectionProposal(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *proposal)
	}
	return out, rows.Err()
}

func (r *SQLiteMCPConnectionProposalRepository) Update(ctx context.Context, proposal *domain.MCPConnectionProposal) error {
	_, err := r.db.ExecContext(ctx, `
		UPDATE mcp_connection_proposals SET status = ?, updated_at = ?
		WHERE workspace_id = ? AND id = ?
	`, proposal.Status, proposal.UpdatedAt, proposal.WorkspaceID, proposal.ID)
	return err
}

type mcpConnectionProposalScanner interface {
	Scan(dest ...any) error
}

func scanMCPConnectionProposal(scanner mcpConnectionProposalScanner) (*domain.MCPConnectionProposal, error) {
	var proposal domain.MCPConnectionProposal
	var targetUpdatedAt sql.NullTime
	err := scanner.Scan(&proposal.ID, &proposal.WorkspaceID, &proposal.Operation, &proposal.TargetProfileID, &proposal.ResultProfileID, &targetUpdatedAt, &proposal.CandidateID, &proposal.Name, &proposal.Driver, &proposal.Host, &proposal.Port, &proposal.Database, &proposal.Username, &proposal.TLSMode, &proposal.Source, &proposal.SourceName, &proposal.Status, &proposal.CreatedAt, &proposal.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if targetUpdatedAt.Valid {
		proposal.TargetUpdatedAt = &targetUpdatedAt.Time
	}
	return &proposal, nil
}
