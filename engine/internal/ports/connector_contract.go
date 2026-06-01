package ports

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/adapters"
	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func VerifyConnectorContract_Unreachable(t *testing.T, connector DBConnector, driver string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	p := domain.ConnectionProfile{
		ID:       "unreachable-1",
		Name:     "Unreachable",
		Driver:   driver,
		Host:     "192.0.2.1",
		Port:     12345,
		Database: "mydb",
		Username: "root",
		TLSMode:  "none",
	}

	err := connector.TestConnection(ctx, p, "pass")
	if err == nil {
		t.Error("expected error for unreachable host, got nil")
	} else if !errors.Is(err, adapters.ErrNetworkUnreachable) && !errors.Is(err, adapters.ErrTimeout) {
		t.Errorf("expected ErrNetworkUnreachable or ErrTimeout, got: %v", err)
	}
}

func VerifyConnectorContract_AuthFailed(t *testing.T, connector DBConnector, driver string, host string, port int, dbName string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	p := domain.ConnectionProfile{
		ID:       "auth-fail-1",
		Name:     "Auth Fail",
		Driver:   driver,
		Host:     host,
		Port:     port,
		Database: dbName,
		Username: "invalid_user_random_xyz",
		TLSMode:  "none",
	}

	err := connector.TestConnection(ctx, p, "wrong_password")
	if err == nil {
		t.Error("expected authentication failure error, got nil")
	} else if !errors.Is(err, adapters.ErrAuthFailed) {
		t.Errorf("expected ErrAuthFailed, got: %v", err)
	}
}
