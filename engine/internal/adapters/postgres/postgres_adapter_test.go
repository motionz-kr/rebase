package postgres

import (
	"errors"
	"testing"

	"context"

	pqDriver "github.com/lib/pq"
	"github.com/smlee/database-local-engine/engine/internal/adapters"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

func TestPostgreSQLConnector_Contract(t *testing.T) {
	connector := NewPostgreSQLConnector()

	t.Run("unreachable", func(t *testing.T) {
		ports.VerifyConnectorContract_Unreachable(t, connector, "postgres")
	})

	t.Run("error mapping", func(t *testing.T) {
		authErr := &pqDriver.Error{
			Code: "28P01",
		}
		
		got := connector.normalizeError(authErr)
		if !errors.Is(got, adapters.ErrAuthFailed) {
			t.Errorf("expected ErrAuthFailed, got: %v", got)
		}
	})

	t.Run("introspection signatures", func(t *testing.T) {
		p := domain.ConnectionProfile{
			ID:        "pg-introspection-1",
			Name:      "PG Introspection",
			Driver:    "postgres",
			Host:      "127.0.0.1",
			Port:      5432,
			Database:  "postgres",
			Username:  "postgres",
			TLSMode:   "none",
		}
		
		// Whether or not a Postgres server is reachable, introspection must
		// surface a NORMALIZED error (never a raw driver error): auth failure
		// if the server is up (wrong password), or network/timeout if it is not.
		_, err := connector.ListDatabases(context.Background(), p, "wrongpassword")
		if err == nil {
			t.Error("expected a normalized error, got nil")
		} else if !errors.Is(err, adapters.ErrAuthFailed) &&
			!errors.Is(err, adapters.ErrNetworkUnreachable) &&
			!errors.Is(err, adapters.ErrTimeout) {
			t.Errorf("expected normalized auth/unreachable/timeout error, got: %v", err)
		}
	})
}
