package ports

import (
	"context"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type MCPConnectionProposalRepository interface {
	Create(ctx context.Context, proposal *domain.MCPConnectionProposal) error
	Get(ctx context.Context, workspaceID, id string) (*domain.MCPConnectionProposal, error)
	List(ctx context.Context, workspaceID, status string, limit int) ([]domain.MCPConnectionProposal, error)
	Update(ctx context.Context, proposal *domain.MCPConnectionProposal) error
}

type MCPConnectionProposalUseCase interface {
	Propose(ctx context.Context, input domain.MCPConnectionProposal) (*domain.MCPConnectionProposal, error)
	List(ctx context.Context, workspaceID, status string, limit int) ([]domain.MCPConnectionProposal, error)
	Resolve(ctx context.Context, workspaceID, id, action string) error
}
