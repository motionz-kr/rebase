package ports

import (
	"context"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type WorkspaceRepository interface {
	SaveWorkspace(ctx context.Context, ws *domain.Workspace) error
	GetWorkspace(ctx context.Context, id string) (*domain.Workspace, error)
	DeleteWorkspace(ctx context.Context, id string) error
	ListWorkspaces(ctx context.Context) ([]*domain.Workspace, error)

	SaveQuery(ctx context.Context, q *domain.SavedQuery) error
	GetQuery(ctx context.Context, id string) (*domain.SavedQuery, error)
	DeleteQuery(ctx context.Context, id string) error
	ListQueries(ctx context.Context, workspaceID string) ([]*domain.SavedQuery, error)

	AddHistory(ctx context.Context, h *domain.QueryHistory) error
	GetHistory(ctx context.Context, id string) (*domain.QueryHistory, error)
	ListHistory(ctx context.Context, workspaceID string, profileID string) ([]*domain.QueryHistory, error)
}
