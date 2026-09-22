package sqlite

import (
	"context"
	"database/sql"
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type SQLiteMCPActivityRepository struct{ db *sql.DB }

func NewSQLiteMCPActivityRepository(db *sql.DB) *SQLiteMCPActivityRepository {
	return &SQLiteMCPActivityRepository{db: db}
}

func (r *SQLiteMCPActivityRepository) Append(ctx context.Context, event *domain.MCPActivityEvent) error {
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO mcp_activity_events
		(id, workspace_id, profile_id, server_id, direction, event, tool, status, error_message, query_text, duration_ms, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, event.ID, event.WorkspaceID, event.ProfileID, event.ServerID, event.Direction, event.Event, event.Tool, event.Status, event.Error, event.QueryText, event.DurationMs, event.CreatedAt)
	return err
}

func (r *SQLiteMCPActivityRepository) List(ctx context.Context, filter domain.MCPActivityFilter) ([]domain.MCPActivityEvent, error) {
	return r.list(ctx, filter, true)
}

func (r *SQLiteMCPActivityRepository) ListSummary(ctx context.Context, filter domain.MCPActivityFilter) ([]domain.MCPActivityEvent, error) {
	return r.list(ctx, filter, false)
}

func (r *SQLiteMCPActivityRepository) list(ctx context.Context, filter domain.MCPActivityFilter, includeQuery bool) ([]domain.MCPActivityEvent, error) {
	limit := filter.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	query := strings.Builder{}
	query.WriteString(`SELECT id, workspace_id, profile_id, server_id, direction, event, tool, status, error_message, `)
	if includeQuery {
		query.WriteString("query_text")
	} else {
		query.WriteString("''")
	}
	query.WriteString(`, duration_ms, created_at FROM mcp_activity_events WHERE workspace_id = ?`)
	args := []any{filter.WorkspaceID}
	if filter.ProfileID != "" {
		query.WriteString(" AND profile_id = ?")
		args = append(args, filter.ProfileID)
	}
	if filter.ServerID != "" {
		query.WriteString(" AND server_id = ?")
		args = append(args, filter.ServerID)
	}
	query.WriteString(" ORDER BY created_at DESC LIMIT ?")
	args = append(args, limit)
	rows, err := r.db.QueryContext(ctx, query.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.MCPActivityEvent, 0)
	for rows.Next() {
		var event domain.MCPActivityEvent
		if err := rows.Scan(&event.ID, &event.WorkspaceID, &event.ProfileID, &event.ServerID, &event.Direction, &event.Event, &event.Tool, &event.Status, &event.Error, &event.QueryText, &event.DurationMs, &event.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, event)
	}
	return out, rows.Err()
}

func (r *SQLiteMCPActivityRepository) Get(ctx context.Context, workspaceID, eventID string) (*domain.MCPActivityEvent, error) {
	var event domain.MCPActivityEvent
	err := r.db.QueryRowContext(ctx, `
		SELECT id, workspace_id, profile_id, server_id, direction, event, tool, status, error_message, query_text, duration_ms, created_at
		FROM mcp_activity_events WHERE workspace_id = ? AND id = ? LIMIT 1
	`, workspaceID, eventID).Scan(
		&event.ID, &event.WorkspaceID, &event.ProfileID, &event.ServerID, &event.Direction,
		&event.Event, &event.Tool, &event.Status, &event.Error, &event.QueryText,
		&event.DurationMs, &event.CreatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &event, nil
}
