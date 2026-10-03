package application

import (
	"context"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type fakeDatabaseDiscovery struct {
	result domain.DatabaseDiscoveryResult
	err    error
}

func (f fakeDatabaseDiscovery) Discover(context.Context) (domain.DatabaseDiscoveryResult, error) {
	return f.result, f.err
}

func TestDatabaseDiscoveryServiceDeduplicatesAndPrefersDockerLabel(t *testing.T) {
	local := domain.DiscoveredDatabase{ID: domain.CandidateID("postgres", "127.0.0.1", 5432), Driver: "postgres", Host: "127.0.0.1", Port: 5432, Source: "local"}
	docker := local
	docker.Source = "docker"
	docker.SourceName = "test-postgres"
	service := NewDatabaseDiscoveryService(fakeDatabaseDiscovery{result: domain.DatabaseDiscoveryResult{
		Candidates:   []domain.DiscoveredDatabase{local, docker},
		DockerStatus: domain.DockerDiscoveryAvailable,
	}})

	got, err := service.Discover(context.Background())
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	if len(got.Candidates) != 1 {
		t.Fatalf("candidate count = %d, want 1", len(got.Candidates))
	}
	if got.Candidates[0].Source != "docker" || got.Candidates[0].SourceName != "test-postgres" {
		t.Fatalf("candidate source = %#v, want Docker metadata", got.Candidates[0])
	}
	if got.DockerStatus != domain.DockerDiscoveryAvailable {
		t.Fatalf("Docker status = %q", got.DockerStatus)
	}
}

func TestDatabaseDiscoveryServiceDropsInvalidCandidates(t *testing.T) {
	service := NewDatabaseDiscoveryService(fakeDatabaseDiscovery{result: domain.DatabaseDiscoveryResult{
		Candidates: []domain.DiscoveredDatabase{
			{ID: domain.CandidateID("mysql", "10.0.0.2", 3306), Driver: "mysql", Host: "10.0.0.2", Port: 3306, Source: "docker"},
			{ID: domain.CandidateID("mysql", "127.0.0.1", 3306), Driver: "mysql", Host: "127.0.0.1", Port: 3306, Source: "local"},
		},
	}})

	got, err := service.Discover(context.Background())
	if err != nil {
		t.Fatalf("Discover() error = %v", err)
	}
	if len(got.Candidates) != 1 || got.Candidates[0].Host != "127.0.0.1" {
		t.Fatalf("candidates = %#v, want only the loopback candidate", got.Candidates)
	}
}
