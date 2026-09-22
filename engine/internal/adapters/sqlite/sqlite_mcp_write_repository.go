package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type SQLiteMCPWriteProposalRepository struct{ db *sql.DB }

func NewSQLiteMCPWriteProposalRepository(db *sql.DB) *SQLiteMCPWriteProposalRepository {
	return &SQLiteMCPWriteProposalRepository{db: db}
}

func (r *SQLiteMCPWriteProposalRepository) Create(ctx context.Context, proposal *domain.MCPWriteProposal) error {
	reasons, _ := json.Marshal(proposal.Reasons)
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO mcp_write_proposals
		(id, workspace_id, profile_id, sql_text, risk, reasons_json, status, rows_affected, error_message, created_at, updated_at, approved_at, executed_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, proposal.ID, proposal.WorkspaceID, proposal.ProfileID, proposal.SQL, proposal.Risk, string(reasons), proposal.Status, proposal.RowsAffected, proposal.Error, proposal.CreatedAt, proposal.UpdatedAt, proposal.ApprovedAt, proposal.ExecutedAt)
	return err
}

func (r *SQLiteMCPWriteProposalRepository) Get(ctx context.Context, workspaceID, id string) (*domain.MCPWriteProposal, error) {
	var proposal domain.MCPWriteProposal
	var reasons string
	err := r.db.QueryRowContext(ctx, `
		SELECT id, workspace_id, profile_id, sql_text, risk, reasons_json, status, rows_affected, error_message, created_at, updated_at, approved_at, executed_at
		FROM mcp_write_proposals WHERE workspace_id = ? AND id = ? LIMIT 1
	`, workspaceID, id).Scan(&proposal.ID, &proposal.WorkspaceID, &proposal.ProfileID, &proposal.SQL, &proposal.Risk, &reasons, &proposal.Status, &proposal.RowsAffected, &proposal.Error, &proposal.CreatedAt, &proposal.UpdatedAt, &proposal.ApprovedAt, &proposal.ExecutedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal([]byte(reasons), &proposal.Reasons)
	return &proposal, nil
}

func (r *SQLiteMCPWriteProposalRepository) List(ctx context.Context, workspaceID, profileID, status string, limit int) ([]domain.MCPWriteProposal, error) {
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	query := strings.Builder{}
	query.WriteString(`SELECT id, workspace_id, profile_id, sql_text, risk, reasons_json, status, rows_affected, error_message, created_at, updated_at, approved_at, executed_at FROM mcp_write_proposals WHERE workspace_id = ?`)
	args := []any{workspaceID}
	if profileID != "" {
		query.WriteString(" AND profile_id = ?")
		args = append(args, profileID)
	}
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
	var out []domain.MCPWriteProposal
	for rows.Next() {
		var proposal domain.MCPWriteProposal
		var reasons string
		if err := rows.Scan(&proposal.ID, &proposal.WorkspaceID, &proposal.ProfileID, &proposal.SQL, &proposal.Risk, &reasons, &proposal.Status, &proposal.RowsAffected, &proposal.Error, &proposal.CreatedAt, &proposal.UpdatedAt, &proposal.ApprovedAt, &proposal.ExecutedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(reasons), &proposal.Reasons)
		out = append(out, proposal)
	}
	return out, rows.Err()
}

func (r *SQLiteMCPWriteProposalRepository) Update(ctx context.Context, proposal *domain.MCPWriteProposal) error {
	reasons, _ := json.Marshal(proposal.Reasons)
	_, err := r.db.ExecContext(ctx, `
		UPDATE mcp_write_proposals
		SET status = ?, rows_affected = ?, error_message = ?, reasons_json = ?, updated_at = ?, approved_at = ?, executed_at = ?
		WHERE workspace_id = ? AND id = ?
	`, proposal.Status, proposal.RowsAffected, proposal.Error, string(reasons), proposal.UpdatedAt, proposal.ApprovedAt, proposal.ExecutedAt, proposal.WorkspaceID, proposal.ID)
	return err
}
