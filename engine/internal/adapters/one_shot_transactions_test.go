package adapters_test

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/adapters/mysql"
	"github.com/smlee/database-local-engine/engine/internal/adapters/postgres"
	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlite"
	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlserver"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

func TestStatelessQueriesRejectTransactionControlBeforeConnecting(t *testing.T) {
	for name, connector := range map[string]ports.SQLConnector{
		"mysql": mysql.NewMySQLConnector(), "postgres": postgres.NewPostgreSQLConnector(),
		"sqlite": sqlite.NewSQLiteConnector(), "sqlserver": sqlserver.NewSQLServerConnector(),
	} {
		t.Run(name, func(t *testing.T) {
			for _, query := range []string{"START TRANSACTION", "COMMIT", "ROLLBACK TO SAVEPOINT before_change"} {
				ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
				p := domain.ConnectionProfile{Driver: name, Host: "127.0.0.1", Port: 1, Database: filepath.Join(t.TempDir(), "test.db")}
				_, err := connector.ExecuteQueryStream(ctx, p, "", query, false, nil, func([]string) error { return nil }, func([]any) error { return nil })
				cancel()
				if err == nil || !strings.Contains(err.Error(), "dedicated query-tab session") {
					t.Fatalf("%s: got %v, want session requirement", query, err)
				}
			}
		})
	}
}
