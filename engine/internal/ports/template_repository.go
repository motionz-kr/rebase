package ports

import (
	"context"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type TemplateRepository interface {
	Create(ctx context.Context, t *domain.Template) error
	List(ctx context.Context, workspaceID string) ([]*domain.Template, error)
	GetByID(ctx context.Context, id string) (*domain.Template, error)
	Update(ctx context.Context, t *domain.Template) error
	Delete(ctx context.Context, id string) error
}
