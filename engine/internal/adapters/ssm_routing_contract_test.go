package adapters_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/adapters/mysql"
	"github.com/smlee/database-local-engine/engine/internal/adapters/postgres"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type routeFailure struct {
	err     error
	ctx     context.Context
	profile domain.ConnectionProfile
	calls   int
}

func (r *routeFailure) ResolveEndpoint(ctx context.Context, p domain.ConnectionProfile) (ports.ConnectionEndpoint, error) {
	r.ctx, r.profile = ctx, p
	r.calls++
	return ports.ConnectionEndpoint{}, r.err
}

// Every operation that opens a DB connection must fail before contacting the
// destination when tunnel resolution fails, including the separate query/session path.
func TestTunnelRoutingContract(t *testing.T) {
	for _, mode := range []string{"ssm", "ssh"} {
		for _, driver := range []string{"mysql", "postgres"} {
			t.Run(mode+"/"+driver, func(t *testing.T) {
				p := domain.ConnectionProfile{ID: "p", Driver: driver, Host: "127.0.0.1", Port: 1, Database: "app", ConnectionMode: mode, SSH: &domain.SSHConfig{Host: "bastion", Port: 22, Username: "ec2-user", IdentityFile: "/key.pem"}, SSM: &domain.SSMConfig{Region: "ap-northeast-2", InstanceID: "i-0123456789abcdef0"}}
				operations := map[string]func(context.Context, ports.SQLConnector) error{
					"connection test": func(ctx context.Context, c ports.SQLConnector) error { return c.TestConnection(ctx, p, "") },
					"databases": func(ctx context.Context, c ports.SQLConnector) error {
						_, err := c.ListDatabases(ctx, p, "")
						return err
					},
					"tables": func(ctx context.Context, c ports.SQLConnector) error {
						_, err := c.ListTables(ctx, p, "", "app")
						return err
					},
					"views": func(ctx context.Context, c ports.SQLConnector) error {
						_, err := c.ListViews(ctx, p, "", "app")
						return err
					},
					"view DDL": func(ctx context.Context, c ports.SQLConnector) error {
						_, err := c.GetViewDDL(ctx, p, "", "app", "v")
						return err
					},
					"describe table": func(ctx context.Context, c ports.SQLConnector) error {
						_, err := c.DescribeTable(ctx, p, "", "app", "t")
						return err
					},
					"table DDL": func(ctx context.Context, c ports.SQLConnector) error {
						_, err := c.GetTableDDL(ctx, p, "", "app", "t")
						return err
					},
					"columns": func(ctx context.Context, c ports.SQLConnector) error {
						_, err := c.ListColumns(ctx, p, "", "app")
						return err
					},
					"foreign keys": func(ctx context.Context, c ports.SQLConnector) error {
						_, err := c.ListForeignKeys(ctx, p, "", "app", "t")
						return err
					},
					"indexes": func(ctx context.Context, c ports.SQLConnector) error {
						_, err := c.ListIndexes(ctx, p, "", "app", "t")
						return err
					},
					"schema graph": func(ctx context.Context, c ports.SQLConnector) error {
						_, err := c.GetSchemaGraph(ctx, p, "", "app")
						return err
					},
					"stream query": func(ctx context.Context, c ports.SQLConnector) error {
						_, err := c.ExecuteQueryStream(ctx, p, "", "SELECT 1", true, nil, nil, nil)
						return err
					},
					"batch transaction": func(ctx context.Context, c ports.SQLConnector) error {
						_, _, err := c.ExecuteBatch(ctx, p, "", []string{"SELECT 1"})
						return err
					},
					"manual session": func(ctx context.Context, c ports.SQLConnector) error {
						_, err := c.(ports.QuerySessionConnector).OpenQuerySession(ctx, p, "", "owner", "app", true)
						return err
					},
					"cancel query": func(ctx context.Context, c ports.SQLConnector) error { return c.CancelSession(ctx, p, "", 123) },
				}
				for name, run := range operations {
					t.Run(name, func(t *testing.T) {
						ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
						defer cancel()
						failure := errors.New("tunnel unavailable: do not dial DB")
						resolver := &routeFailure{err: failure}
						var c ports.SQLConnector
						if driver == "mysql" {
							c = mysql.NewMySQLConnector(resolver)
						} else {
							c = postgres.NewPostgreSQLConnector(resolver)
						}
						if err := run(ctx, c); !errors.Is(err, failure) {
							t.Fatalf("expected resolver failure; got %v", err)
						}
						if resolver.calls != 1 || resolver.ctx != ctx || !reflect.DeepEqual(resolver.profile, p) {
							t.Fatalf("resolver did not receive original context/profile exactly once: %+v", resolver)
						}
					})
				}
			})
		}
	}
}
