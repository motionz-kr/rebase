package application

import (
	"context"
	"sort"
	"strconv"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type DatabaseDiscoveryService struct {
	discovery ports.DatabaseDiscovery
}

func NewDatabaseDiscoveryService(discovery ports.DatabaseDiscovery) *DatabaseDiscoveryService {
	return &DatabaseDiscoveryService{discovery: discovery}
}

func (s *DatabaseDiscoveryService) Discover(ctx context.Context) (domain.DatabaseDiscoveryResult, error) {
	result, err := s.discovery.Discover(ctx)
	if err != nil {
		return domain.DatabaseDiscoveryResult{}, err
	}

	byEndpoint := make(map[string]domain.DiscoveredDatabase, len(result.Candidates))
	for _, candidate := range result.Candidates {
		if candidate.Validate() != nil {
			continue
		}
		key := candidate.Driver + "|" + candidate.Host + "|" + fmtPort(candidate.Port)
		current, exists := byEndpoint[key]
		if !exists || (candidate.Source == "docker" && current.Source != "docker") {
			byEndpoint[key] = candidate
		}
	}

	out := domain.DatabaseDiscoveryResult{Candidates: make([]domain.DiscoveredDatabase, 0, len(byEndpoint)), DockerStatus: result.DockerStatus}
	for _, candidate := range byEndpoint {
		out.Candidates = append(out.Candidates, candidate)
	}
	sort.Slice(out.Candidates, func(i, j int) bool {
		if out.Candidates[i].Driver != out.Candidates[j].Driver {
			return out.Candidates[i].Driver < out.Candidates[j].Driver
		}
		return out.Candidates[i].Port < out.Candidates[j].Port
	})
	return out, nil
}

func fmtPort(port int) string {
	return strconv.Itoa(port)
}
