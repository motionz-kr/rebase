package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type SQLiteMcpServerRepository struct{ db *sql.DB }

func NewSQLiteMcpServerRepository(db *sql.DB) *SQLiteMcpServerRepository {
	return &SQLiteMcpServerRepository{db: db}
}

func (r *SQLiteMcpServerRepository) Create(ctx context.Context, s *domain.McpServer) error {
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO mcp_servers (id, workspace_id, name, command, args, enabled, trusted, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, s.ID, s.WorkspaceID, s.Name, s.Command, s.Args, s.Enabled, s.Trusted, s.CreatedAt, s.UpdatedAt)
	return err
}

func (r *SQLiteMcpServerRepository) List(ctx context.Context, workspaceID string) ([]domain.McpServer, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT id, workspace_id, name, command, args, enabled, trusted, created_at, updated_at
		FROM mcp_servers WHERE workspace_id = ? ORDER BY name
	`, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.McpServer
	for rows.Next() {
		var s domain.McpServer
		if err := rows.Scan(&s.ID, &s.WorkspaceID, &s.Name, &s.Command, &s.Args, &s.Enabled, &s.Trusted, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, nil
}

func (r *SQLiteMcpServerRepository) Update(ctx context.Context, s *domain.McpServer) error {
	s.UpdatedAt = time.Now()
	res, err := r.db.ExecContext(ctx, `
		UPDATE mcp_servers SET name = ?, command = ?, args = ?, enabled = ?, trusted = ?, updated_at = ?
		WHERE id = ?
	`, s.Name, s.Command, s.Args, s.Enabled, s.Trusted, s.UpdatedAt, s.ID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return errors.New("mcp server not found")
	}
	return nil
}

func (r *SQLiteMcpServerRepository) Delete(ctx context.Context, id string) error {
	res, err := r.db.ExecContext(ctx, "DELETE FROM mcp_servers WHERE id = ?", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return errors.New("mcp server not found")
	}
	return nil
}
