package ports

import (
	"context"
	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type ProfileRepository interface {
	Create(ctx context.Context, profile *domain.ConnectionProfile) error
	GetByID(ctx context.Context, id string) (*domain.ConnectionProfile, error)
	List(ctx context.Context) ([]domain.ConnectionProfile, error)
	Update(ctx context.Context, profile *domain.ConnectionProfile) error
	Delete(ctx context.Context, id string) error
}
