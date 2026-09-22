package ports

import (
	"context"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type MCPActivityRepository interface {
	Append(ctx context.Context, event *domain.MCPActivityEvent) error
	List(ctx context.Context, filter domain.MCPActivityFilter) ([]domain.MCPActivityEvent, error)
	ListSummary(ctx context.Context, filter domain.MCPActivityFilter) ([]domain.MCPActivityEvent, error)
	// Get returns nil, nil when the event does not exist in the workspace.
	Get(ctx context.Context, workspaceID, eventID string) (*domain.MCPActivityEvent, error)
}
