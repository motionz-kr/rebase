package ports

import (
	"context"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type DatabaseDiscovery interface {
	Discover(ctx context.Context) (domain.DatabaseDiscoveryResult, error)
}
