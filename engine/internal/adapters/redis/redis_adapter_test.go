package redis

import (
	"errors"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/adapters"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

func TestRedisConnector_Contract(t *testing.T) {
	connector := NewRedisConnector()

	t.Run("unreachable", func(t *testing.T) {
		ports.VerifyConnectorContract_Unreachable(t, connector, "redis")
	})

	t.Run("error mapping", func(t *testing.T) {
		authErr := errors.New("ERR Client sent AUTH, but no password is set")
		got := connector.normalizeError(authErr)
		if !errors.Is(got, adapters.ErrAuthFailed) {
			t.Errorf("expected ErrAuthFailed, got: %v", got)
		}

		wrongPassErr := errors.New("WRONGPASS Invalid username-password pair")
		got = connector.normalizeError(wrongPassErr)
		if !errors.Is(got, adapters.ErrAuthFailed) {
			t.Errorf("expected ErrAuthFailed, got: %v", got)
		}
	})
}
