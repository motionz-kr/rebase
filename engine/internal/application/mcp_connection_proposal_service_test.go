package application

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type fakeMCPConnectionProposalRepository struct {
	proposals map[string]*domain.MCPConnectionProposal
}

func (f *fakeMCPConnectionProposalRepository) Create(_ context.Context, proposal *domain.MCPConnectionProposal) error {
	if f.proposals == nil {
		f.proposals = map[string]*domain.MCPConnectionProposal{}
	}
	copy := *proposal
	f.proposals[proposal.ID] = &copy
	return nil
}
func (f *fakeMCPConnectionProposalRepository) Get(_ context.Context, workspaceID, id string) (*domain.MCPConnectionProposal, error) {
	proposal := f.proposals[id]
	if proposal == nil || proposal.WorkspaceID != workspaceID {
		return nil, nil
	}
	copy := *proposal
	return &copy, nil
}
func (f *fakeMCPConnectionProposalRepository) List(_ context.Context, workspaceID, status string, limit int) ([]domain.MCPConnectionProposal, error) {
	var out []domain.MCPConnectionProposal
	for _, proposal := range f.proposals {
		if proposal.WorkspaceID == workspaceID && (status == "" || proposal.Status == status) {
			out = append(out, *proposal)
		}
	}
	return out, nil
}
func (f *fakeMCPConnectionProposalRepository) Update(_ context.Context, proposal *domain.MCPConnectionProposal) error {
	copy := *proposal
	f.proposals[proposal.ID] = &copy
	return nil
}

func TestMCPConnectionProposalServiceBindsProposalToDiscoveredLoopbackCandidate(t *testing.T) {
	candidate := domain.DiscoveredDatabase{ID: domain.CandidateID("mysql", "127.0.0.1", 3307), Driver: "mysql", Host: "127.0.0.1", Port: 3307, Source: "docker", SourceName: "test-mysql"}
	discovery := fakeDatabaseDiscovery{result: domain.DatabaseDiscoveryResult{Candidates: []domain.DiscoveredDatabase{candidate}}}
	profiles := ports.NewFakeProfileRepository()
	repository := &fakeMCPConnectionProposalRepository{}
	service := NewMCPConnectionProposalService(repository, profiles, discovery)

	proposal, err := service.Propose(context.Background(), domain.MCPConnectionProposal{
		Operation: domain.MCPConnectionProposalCreate, CandidateID: candidate.ID, Name: "Test database", Database: "app_test", Username: "tester",
	})
	if err != nil {
		t.Fatalf("Propose() error = %v", err)
	}
	if proposal.Driver != "mysql" || proposal.Host != "127.0.0.1" || proposal.Port != 3307 || proposal.SourceName != "test-mysql" {
		t.Fatalf("proposal endpoint = %#v", proposal)
	}
	encoded, err := json.Marshal(proposal)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "mcpEnabled") || strings.Contains(string(encoded), "mcpWriteMode") || strings.Contains(string(encoded), "password") {
		t.Fatalf("proposal contains a secret or permission field: %s", encoded)
	}
}

func TestMCPConnectionProposalServiceRejectsUnknownCandidateAndUnknownProfile(t *testing.T) {
	candidate := domain.DiscoveredDatabase{ID: domain.CandidateID("postgres", "127.0.0.1", 5432), Driver: "postgres", Host: "127.0.0.1", Port: 5432, Source: "local"}
	service := NewMCPConnectionProposalService(&fakeMCPConnectionProposalRepository{}, ports.NewFakeProfileRepository(), fakeDatabaseDiscovery{result: domain.DatabaseDiscoveryResult{Candidates: []domain.DiscoveredDatabase{candidate}}})

	_, err := service.Propose(context.Background(), domain.MCPConnectionProposal{Operation: domain.MCPConnectionProposalCreate, CandidateID: "unknown", Name: "local"})
	if err == nil || !strings.Contains(err.Error(), "candidate") {
		t.Fatalf("unknown candidate error = %v", err)
	}
	_, err = service.Propose(context.Background(), domain.MCPConnectionProposal{Operation: domain.MCPConnectionProposalUpdate, CandidateID: candidate.ID, TargetProfileID: "missing", Name: "updated"})
	if err == nil || !strings.Contains(err.Error(), "profile") {
		t.Fatalf("unknown profile error = %v", err)
	}
}
