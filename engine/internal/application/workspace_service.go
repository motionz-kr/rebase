package application

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type WorkspaceService struct {
	repo ports.WorkspaceRepository
}

func NewWorkspaceService(repo ports.WorkspaceRepository) *WorkspaceService {
	return &WorkspaceService{repo: repo}
}

func (s *WorkspaceService) SaveWorkspace(ctx context.Context, id, name string) (*domain.Workspace, error) {
	if id == "" {
		id = uuid.NewString()
	}
	ws := &domain.Workspace{
		ID:        id,
		Name:      name,
		Version:   1,
		SyncState: "local",
		CreatedAt: time.Now(),
		UpdatedAt: time.Now(),
	}
	if err := ws.Validate(); err != nil {
		return nil, err
	}
	if err := s.repo.SaveWorkspace(ctx, ws); err != nil {
		return nil, err
	}
	return ws, nil
}

func (s *WorkspaceService) GetWorkspace(ctx context.Context, id string) (*domain.Workspace, error) {
	return s.repo.GetWorkspace(ctx, id)
}

func (s *WorkspaceService) ListWorkspaces(ctx context.Context) ([]*domain.Workspace, error) {
	return s.repo.ListWorkspaces(ctx)
}

func (s *WorkspaceService) SaveQuery(ctx context.Context, id, workspaceID, profileID, name, queryText string, isFavorite bool) (*domain.SavedQuery, error) {
	if id == "" {
		id = uuid.NewString()
	}

	q := &domain.SavedQuery{
		ID:          id,
		WorkspaceID: workspaceID,
		ProfileID:   profileID,
		Name:        name,
		QueryText:   queryText,
		IsFavorite:  isFavorite,
		Version:     1,
		SyncState:   "local",
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}

	if err := q.Validate(); err != nil {
		return nil, err
	}

	if err := s.repo.SaveQuery(ctx, q); err != nil {
		return nil, err
	}

	return q, nil
}

func (s *WorkspaceService) GetQuery(ctx context.Context, id string) (*domain.SavedQuery, error) {
	return s.repo.GetQuery(ctx, id)
}

func (s *WorkspaceService) DeleteQuery(ctx context.Context, id string) error {
	return s.repo.DeleteQuery(ctx, id)
}

func (s *WorkspaceService) ListQueries(ctx context.Context, workspaceID string) ([]*domain.SavedQuery, error) {
	return s.repo.ListQueries(ctx, workspaceID)
}

func (s *WorkspaceService) AddHistory(ctx context.Context, workspaceID, profileID, queryText string, durationMs int64, success bool, errorMessage *string, rowCount *int64) (*domain.QueryHistory, error) {
	h := &domain.QueryHistory{
		ID:           uuid.NewString(),
		WorkspaceID:  workspaceID,
		ProfileID:    profileID,
		QueryText:    queryText,
		ExecutedAt:   time.Now(),
		DurationMs:   durationMs,
		Success:      success,
		ErrorMessage: errorMessage,
		RowCount:     rowCount,
		Version:      1,
		SyncState:    "local",
	}

	if err := h.Validate(); err != nil {
		return nil, err
	}

	if err := s.repo.AddHistory(ctx, h); err != nil {
		return nil, err
	}

	return h, nil
}

func (s *WorkspaceService) ListHistory(ctx context.Context, workspaceID, profileID string) ([]*domain.QueryHistory, error) {
	return s.repo.ListHistory(ctx, workspaceID, profileID)
}

// Phase 8 Stubs
func (s *WorkspaceService) GetAccount(ctx context.Context) (*domain.Account, error) {
	return &domain.Account{
		ID:        "acc-local-stub",
		Email:     "user@antigravity.dev",
		Token:     "stub-jwt-token-xyz",
		CreatedAt: time.Now(),
	}, nil
}

func (s *WorkspaceService) GetMCPSettings(ctx context.Context) (*domain.MCPSettings, error) {
	return &domain.MCPSettings{
		Enabled:    true,
		AllowedDBs: []string{"default-mcp-db"},
	}, nil
}

func (s *WorkspaceService) SaveMCPSettings(ctx context.Context, enabled bool, allowedDBs []string) (*domain.MCPSettings, error) {
	return &domain.MCPSettings{
		Enabled:    enabled,
		AllowedDBs: allowedDBs,
	}, nil
}
