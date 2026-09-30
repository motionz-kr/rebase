package ports

import (
	"context"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type ConnectionEndpoint struct {
	Host string
	Port int
}

type ConnectionEndpointResolver interface {
	ResolveEndpoint(context.Context, domain.ConnectionProfile) (ConnectionEndpoint, error)
}

type TunnelManager interface {
	ConnectionEndpointResolver
	CloseProfile(profileID string)
}
