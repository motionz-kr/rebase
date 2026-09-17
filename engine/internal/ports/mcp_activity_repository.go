package ports

import (
	"context"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type MCPActivityRepository interface {
	Append(ctx context.Context, event *domain.MCPActivityEvent) error
	List(ctx context.Context, filter domain.MCPActivityFilter) ([]domain.MCPActivityEvent, error)
}
