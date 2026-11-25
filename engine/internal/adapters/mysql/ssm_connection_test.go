package mysql

import (
	"context"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type ssmTestResolver struct {
	endpoint ports.ConnectionEndpoint
	calls    int
}

func (r *ssmTestResolver) ResolveEndpoint(context.Context, domain.ConnectionProfile) (ports.ConnectionEndpoint, error) {
	r.calls++
	return r.endpoint, nil
}

func TestSSMHostBlockedStopsConnecting(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	var attempts atomic.Int32
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			attempts.Add(1)
			_ = writePacket(conn, 0, []byte("\xff\x69\x04#HY000Host '192.0.2.10' is blocked"))
			_ = conn.Close()
		}
	}()
	resolver := &ssmTestResolver{endpoint: ports.ConnectionEndpoint{Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port}}
	c := NewMySQLConnector(resolver)
	p := domain.ConnectionProfile{ID: "saved", Driver: "mysql", Host: "db.example.test", Port: 3306, ConnectionMode: "ssm", SSM: &domain.SSMConfig{
		Region: "ap-northeast-2", InstanceID: "i-0123456789abcdef0",
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err = c.OpenQuerySession(ctx, p, "", "owner", "test", true)
	if err == nil || !strings.Contains(err.Error(), "host_cache") {
		t.Errorf("query session error = %v, want actionable host block error", err)
	}
	p.ID = "connection-test"
	if err := c.TestConnection(ctx, p, ""); err == nil || !strings.Contains(err.Error(), "host_cache") {
		t.Errorf("connection test error = %v, want actionable host block error", err)
	}
	if resolver.calls != 1 || attempts.Load() != 1 {
		t.Fatalf("endpoint resolutions = %d, DB attempts = %d, want one each", resolver.calls, attempts.Load())
	}
	// A different DB route is still usable, and a new request can test whether
	// the administrator has cleared the original block after the cooldown.
	other := p
	other.Host = "other.example.test"
	if err := c.TestConnection(ctx, other, ""); err == nil || attempts.Load() != 2 {
		t.Fatalf("other route did not reach its DB: %v (%d attempts)", err, attempts.Load())
	}
	c.ssmHostBlocks.blockedAt[mysqlSSMRoute(p)] = time.Now().Add(-time.Minute)
	if err := c.TestConnection(ctx, p, ""); err == nil || attempts.Load() != 3 {
		t.Fatalf("expired block did not allow a connection: %v (%d attempts)", err, attempts.Load())
	}
}
