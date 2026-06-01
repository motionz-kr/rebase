package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type SQLiteWorkspaceRepository struct {
	db *sql.DB
}

func NewSQLiteWorkspaceRepository(db *sql.DB) *SQLiteWorkspaceRepository {
	return &SQLiteWorkspaceRepository{db: db}
}

func (r *SQLiteWorkspaceRepository) SaveWorkspace(ctx context.Context, ws *domain.Workspace) error {
	query := `
		INSERT INTO workspaces (id, name, remote_id, version, sync_state, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			remote_id = excluded.remote_id,
			version = excluded.version,
			sync_state = excluded.sync_state,
			updated_at = excluded.updated_at
	`
	_, err := r.db.ExecContext(ctx, query,
		ws.ID,
		ws.Name,
		ws.RemoteID,
		ws.Version,
		ws.SyncState,
		ws.CreatedAt,
		ws.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("failed to save workspace: %w", err)
	}
	return nil
}

func (r *SQLiteWorkspaceRepository) GetWorkspace(ctx context.Context, id string) (*domain.Workspace, error) {
	query := `
		SELECT id, name, remote_id, version, sync_state, created_at, updated_at
		FROM workspaces
		WHERE id = ?
	`
	row := r.db.QueryRowContext(ctx, query, id)
	var ws domain.Workspace
	err := row.Scan(
		&ws.ID,
		&ws.Name,
		&ws.RemoteID,
		&ws.Version,
		&ws.SyncState,
		&ws.CreatedAt,
		&ws.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("workspace not found: %w", err)
		}
		return nil, fmt.Errorf("failed to get workspace: %w", err)
	}
	return &ws, nil
}

func (r *SQLiteWorkspaceRepository) DeleteWorkspace(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, "DELETE FROM workspaces WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("failed to delete workspace: %w", err)
	}
	return nil
}

func (r *SQLiteWorkspaceRepository) ListWorkspaces(ctx context.Context) ([]*domain.Workspace, error) {
	query := `
		SELECT id, name, remote_id, version, sync_state, created_at, updated_at
		FROM workspaces
	`
	rows, err := r.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to query workspaces: %w", err)
	}
	defer rows.Close()

	var list []*domain.Workspace
	for rows.Next() {
		var ws domain.Workspace
		err := rows.Scan(
			&ws.ID,
			&ws.Name,
			&ws.RemoteID,
			&ws.Version,
			&ws.SyncState,
			&ws.CreatedAt,
			&ws.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan workspace: %w", err)
		}
		list = append(list, &ws)
	}
	return list, nil
}

func (r *SQLiteWorkspaceRepository) SaveQuery(ctx context.Context, q *domain.SavedQuery) error {
	query := `
		INSERT INTO saved_queries (id, workspace_id, profile_id, name, query_text, is_favorite, remote_id, version, sync_state, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			workspace_id = excluded.workspace_id,
			profile_id = excluded.profile_id,
			name = excluded.name,
			query_text = excluded.query_text,
			is_favorite = excluded.is_favorite,
			remote_id = excluded.remote_id,
			version = excluded.version,
			sync_state = excluded.sync_state,
			updated_at = excluded.updated_at
	`
	isFavoriteInt := 0
	if q.IsFavorite {
		isFavoriteInt = 1
	}

	_, err := r.db.ExecContext(ctx, query,
		q.ID,
		q.WorkspaceID,
		q.ProfileID,
		q.Name,
		q.QueryText,
		isFavoriteInt,
		q.RemoteID,
		q.Version,
		q.SyncState,
		q.CreatedAt,
		q.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("failed to save query: %w", err)
	}
	return nil
}

func (r *SQLiteWorkspaceRepository) GetQuery(ctx context.Context, id string) (*domain.SavedQuery, error) {
	query := `
		SELECT id, workspace_id, profile_id, name, query_text, is_favorite, remote_id, version, sync_state, created_at, updated_at
		FROM saved_queries
		WHERE id = ?
	`
	row := r.db.QueryRowContext(ctx, query, id)
	var q domain.SavedQuery
	var isFavoriteInt int
	err := row.Scan(
		&q.ID,
		&q.WorkspaceID,
		&q.ProfileID,
		&q.Name,
		&q.QueryText,
		&isFavoriteInt,
		&q.RemoteID,
		&q.Version,
		&q.SyncState,
		&q.CreatedAt,
		&q.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("query not found: %w", err)
		}
		return nil, fmt.Errorf("failed to get query: %w", err)
	}
	q.IsFavorite = (isFavoriteInt == 1)
	return &q, nil
}

func (r *SQLiteWorkspaceRepository) DeleteQuery(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, "DELETE FROM saved_queries WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("failed to delete query: %w", err)
	}
	return nil
}

func (r *SQLiteWorkspaceRepository) ListQueries(ctx context.Context, workspaceID string) ([]*domain.SavedQuery, error) {
	query := `
		SELECT id, workspace_id, profile_id, name, query_text, is_favorite, remote_id, version, sync_state, created_at, updated_at
		FROM saved_queries
		WHERE workspace_id = ?
	`
	rows, err := r.db.QueryContext(ctx, query, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("failed to query saved_queries: %w", err)
	}
	defer rows.Close()

	var list []*domain.SavedQuery
	for rows.Next() {
		var q domain.SavedQuery
		var isFavoriteInt int
		err := rows.Scan(
			&q.ID,
			&q.WorkspaceID,
			&q.ProfileID,
			&q.Name,
			&q.QueryText,
			&isFavoriteInt,
			&q.RemoteID,
			&q.Version,
			&q.SyncState,
			&q.CreatedAt,
			&q.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan saved_query: %w", err)
		}
		q.IsFavorite = (isFavoriteInt == 1)
		list = append(list, &q)
	}
	return list, nil
}

func (r *SQLiteWorkspaceRepository) AddHistory(ctx context.Context, h *domain.QueryHistory) error {
	query := `
		INSERT INTO query_history (id, workspace_id, profile_id, query_text, executed_at, duration_ms, success, error_message, row_count, remote_id, version, sync_state)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`
	successInt := 0
	if h.Success {
		successInt = 1
	}

	_, err := r.db.ExecContext(ctx, query,
		h.ID,
		h.WorkspaceID,
		h.ProfileID,
		h.QueryText,
		h.ExecutedAt,
		h.DurationMs,
		successInt,
		h.ErrorMessage,
		h.RowCount,
		h.RemoteID,
		h.Version,
		h.SyncState,
	)
	if err != nil {
		return fmt.Errorf("failed to add history: %w", err)
	}
	return nil
}

func (r *SQLiteWorkspaceRepository) GetHistory(ctx context.Context, id string) (*domain.QueryHistory, error) {
	query := `
		SELECT id, workspace_id, profile_id, query_text, executed_at, duration_ms, success, error_message, row_count, remote_id, version, sync_state
		FROM query_history
		WHERE id = ?
	`
	row := r.db.QueryRowContext(ctx, query, id)
	var h domain.QueryHistory
	var successInt int
	err := row.Scan(
		&h.ID,
		&h.WorkspaceID,
		&h.ProfileID,
		&h.QueryText,
		&h.ExecutedAt,
		&h.DurationMs,
		&successInt,
		&h.ErrorMessage,
		&h.RowCount,
		&h.RemoteID,
		&h.Version,
		&h.SyncState,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("history not found: %w", err)
		}
		return nil, fmt.Errorf("failed to get history: %w", err)
	}
	h.Success = (successInt == 1)
	return &h, nil
}

func (r *SQLiteWorkspaceRepository) ListHistory(ctx context.Context, workspaceID string, profileID string) ([]*domain.QueryHistory, error) {
	query := `
		SELECT id, workspace_id, profile_id, query_text, executed_at, duration_ms, success, error_message, row_count, remote_id, version, sync_state
		FROM query_history
		WHERE workspace_id = ? AND profile_id = ?
		ORDER BY executed_at DESC
	`
	rows, err := r.db.QueryContext(ctx, query, workspaceID, profileID)
	if err != nil {
		return nil, fmt.Errorf("failed to query query_history: %w", err)
	}
	defer rows.Close()

	var list []*domain.QueryHistory
	for rows.Next() {
		var h domain.QueryHistory
		var successInt int
		err := rows.Scan(
			&h.ID,
			&h.WorkspaceID,
			&h.ProfileID,
			&h.QueryText,
			&h.ExecutedAt,
			&h.DurationMs,
			&successInt,
			&h.ErrorMessage,
			&h.RowCount,
			&h.RemoteID,
			&h.Version,
			&h.SyncState,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan query_history: %w", err)
		}
		h.Success = (successInt == 1)
		list = append(list, &h)
	}
	return list, nil
}
