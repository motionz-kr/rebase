package application

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type MCPConnectionProposalService struct {
	proposals ports.MCPConnectionProposalRepository
	profiles  ports.ProfileRepository
	discovery ports.DatabaseDiscovery
}

func NewMCPConnectionProposalService(proposals ports.MCPConnectionProposalRepository, profiles ports.ProfileRepository, discovery ports.DatabaseDiscovery) *MCPConnectionProposalService {
	return &MCPConnectionProposalService{proposals: proposals, profiles: profiles, discovery: discovery}
}

func (s *MCPConnectionProposalService) Propose(ctx context.Context, input domain.MCPConnectionProposal) (*domain.MCPConnectionProposal, error) {
	if input.Operation != domain.MCPConnectionProposalCreate && input.Operation != domain.MCPConnectionProposalUpdate {
		return nil, errors.New("unsupported connection proposal operation")
	}
	candidates, err := s.discovery.Discover(ctx)
	if err != nil {
		return nil, fmt.Errorf("discover local database candidates: %w", err)
	}
	var candidate *domain.DiscoveredDatabase
	for i := range candidates.Candidates {
		if candidates.Candidates[i].ID == input.CandidateID && candidates.Candidates[i].Validate() == nil {
			candidate = &candidates.Candidates[i]
			break
		}
	}
	if candidate == nil {
		return nil, errors.New("discovered database candidate is no longer available")
	}

	proposal := input
	proposal.ID = uuid.NewString()
	proposal.WorkspaceID = "default"
	proposal.ResultProfileID = ""
	if proposal.Operation == domain.MCPConnectionProposalCreate {
		proposal.TargetProfileID = ""
		proposal.ResultProfileID = uuid.NewString()
		if strings.TrimSpace(proposal.Name) == "" {
			proposal.Name = fmt.Sprintf("%s · %s:%d", candidate.Driver, candidate.Host, candidate.Port)
		}
	} else {
		if proposal.TargetProfileID == "" {
			return nil, errors.New("target profile is required for an update proposal")
		}
		profile, err := s.profiles.GetByID(ctx, proposal.TargetProfileID)
		if err != nil {
			return nil, fmt.Errorf("load target connection profile: %w", err)
		}
		if profile == nil {
			return nil, errors.New("target connection profile not found")
		}
		if profile.Driver != candidate.Driver {
			return nil, errors.New("update proposal must keep the target profile's database driver")
		}
		if strings.TrimSpace(proposal.Name) == "" {
			proposal.Name = profile.Name
		}
		if proposal.Database == "" {
			proposal.Database = profile.Database
		}
		if proposal.Username == "" {
			proposal.Username = profile.Username
		}
		if proposal.TLSMode == "" {
			proposal.TLSMode = profile.TLSMode
		}
		updated := profile.UpdatedAt
		proposal.TargetUpdatedAt = &updated
	}
	proposal.CandidateID = candidate.ID
	proposal.Driver = candidate.Driver
	proposal.Host = candidate.Host
	proposal.Port = candidate.Port
	proposal.Source = candidate.Source
	proposal.SourceName = candidate.SourceName
	if proposal.TLSMode == "" {
		proposal.TLSMode = "none"
	}
	proposal.Status = domain.MCPConnectionProposalPending
	proposal.CreatedAt = time.Now().UTC()
	proposal.UpdatedAt = proposal.CreatedAt
	if err := proposal.Validate(); err != nil {
		return nil, err
	}
	if err := s.proposals.Create(ctx, &proposal); err != nil {
		return nil, fmt.Errorf("save connection proposal: %w", err)
	}
	return &proposal, nil
}

func (s *MCPConnectionProposalService) List(ctx context.Context, workspaceID, status string, limit int) ([]domain.MCPConnectionProposal, error) {
	if workspaceID == "" {
		workspaceID = "default"
	}
	return s.proposals.List(ctx, workspaceID, status, limit)
}

func (s *MCPConnectionProposalService) Resolve(ctx context.Context, workspaceID, id, action string) error {
	if workspaceID == "" {
		workspaceID = "default"
	}
	proposal, err := s.proposals.Get(ctx, workspaceID, id)
	if err != nil {
		return err
	}
	if proposal == nil {
		return errors.New("connection proposal not found")
	}
	if proposal.Status != domain.MCPConnectionProposalPending {
		if (action == "applied" && proposal.Status == domain.MCPConnectionProposalApplied) || (action == "reject" && proposal.Status == domain.MCPConnectionProposalRejected) {
			return nil
		}
		return errors.New("connection proposal is no longer pending")
	}
	switch action {
	case "applied":
		proposal.Status = domain.MCPConnectionProposalApplied
	case "reject":
		proposal.Status = domain.MCPConnectionProposalRejected
	default:
		return errors.New("unsupported connection proposal action")
	}
	proposal.UpdatedAt = time.Now().UTC()
	return s.proposals.Update(ctx, proposal)
}
