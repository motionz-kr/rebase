package postgres

import (
	"context"
	"errors"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
	"testing"
)

type failingEndpointResolver struct{}

func (failingEndpointResolver) ResolveEndpoint(context.Context, domain.ConnectionProfile) (ports.ConnectionEndpoint, error) {
	return ports.ConnectionEndpoint{}, errors.New("SSO expired")
}
func TestSSMNeverFallsBackToDirect(t *testing.T) {
	p := domain.ConnectionProfile{Driver: "postgres", Host: "db.internal", Port: 3306, ConnectionMode: "ssm"}
	c := NewPostgreSQLConnector(failingEndpointResolver{})
	if err := c.TestConnection(context.Background(), p, ""); err == nil || err.Error() != "SSO expired" {
		t.Fatal(err)
	}
	c = NewPostgreSQLConnector()
	if err := c.TestConnection(context.Background(), p, ""); err == nil {
		t.Fatal("missing resolver must refuse SSM")
	}
}
