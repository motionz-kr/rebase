package mysql

import (
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

func TestMySQLConnector_Contract(t *testing.T) {
	connector := NewMySQLConnector()

	t.Run("unreachable", func(t *testing.T) {
		ports.VerifyConnectorContract_Unreachable(t, connector, "mysql")
	})

	t.Run("auth failed", func(t *testing.T) {
		ports.VerifyConnectorContract_AuthFailed(t, connector, "mysql", "127.0.0.1", 3306, "mysql")
	})

	t.Run("introspection", func(t *testing.T) {
		p := domain.ConnectionProfile{
			ID:        "mysql-introspection-1",
			Name:      "MySQL Introspection",
			Driver:    "mysql",
			Host:      "127.0.0.1",
			Port:      3306,
			Database:  "information_schema",
			Username:  "root",
			TLSMode:   "none",
		}
		ports.VerifySQLConnectorIntrospection(t, connector, p, "password1!", "information_schema")
	})
}
