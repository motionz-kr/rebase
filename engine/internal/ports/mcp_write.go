package ports

import (
	"context"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type MCPWriteProposalRepository interface {
	Create(ctx context.Context, proposal *domain.MCPWriteProposal) error
	Get(ctx context.Context, workspaceID, id string) (*domain.MCPWriteProposal, error)
	List(ctx context.Context, workspaceID, profileID, status string, limit int) ([]domain.MCPWriteProposal, error)
	Update(ctx context.Context, proposal *domain.MCPWriteProposal) error
}
