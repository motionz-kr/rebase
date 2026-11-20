package sqlserver

import (
	"context"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type fixedResolver struct {
	endpoint ports.ConnectionEndpoint
	profile  domain.ConnectionProfile
}

func (r *fixedResolver) ResolveEndpoint(_ context.Context, p domain.ConnectionProfile) (ports.ConnectionEndpoint, error) {
	r.profile = p
	return r.endpoint, nil
}

// listen returns a loopback listener that counts and immediately closes accepted connections.
func listen(t *testing.T) (host string, port int, accepted *atomic.Int32) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	accepted = new(atomic.Int32)
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			accepted.Add(1)
			conn.Close()
		}
	}()
	addr := l.Addr().(*net.TCPAddr)
	return addr.IP.String(), addr.Port, accepted
}

func ctx(t *testing.T) context.Context {
	c, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	t.Cleanup(cancel)
	return c
}

func TestResolvedEndpointReplacesProfileDestination(t *testing.T) {
	host, port, accepted := listen(t)
	// The profile points at an address nothing listens on; only the resolved endpoint is reachable.
	p := domain.ConnectionProfile{Driver: "sqlserver", Host: "203.0.113.1", Port: 1, ConnectionMode: "gcp_cloudsql", TLSMode: "none"}
	r := &fixedResolver{endpoint: ports.ConnectionEndpoint{Host: host, Port: port}}
	_ = NewSQLServerConnector(r).TestConnection(ctx(t), p, "pw")
	if accepted.Load() == 0 {
		t.Fatal("connection did not reach the resolved endpoint")
	}
	if r.profile.Host != "203.0.113.1" || r.profile.Port != 1 {
		t.Fatalf("resolver must receive the original profile, got %+v", r.profile)
	}
	if p.Host != "203.0.113.1" || p.Port != 1 {
		t.Fatal("caller profile was mutated")
	}
}

func TestNonDirectModeWithoutResolverIsRejected(t *testing.T) {
	host, port, accepted := listen(t)
	for _, mode := range []string{"gcp_cloudsql", "ssm", "ssh"} {
		p := domain.ConnectionProfile{Driver: "sqlserver", Host: host, Port: port, ConnectionMode: mode}
		err := NewSQLServerConnector().TestConnection(ctx(t), p, "")
		if err == nil || err.Error() != "connection endpoint resolver is unavailable" {
			t.Fatalf("%s: got %v", mode, err)
		}
	}
	if accepted.Load() != 0 {
		t.Fatal("must not dial when the resolver is missing")
	}
}

func TestEmptyAndDirectModesDialProfileWithoutResolver(t *testing.T) {
	for _, mode := range []string{"", "direct"} {
		host, port, accepted := listen(t)
		p := domain.ConnectionProfile{Driver: "sqlserver", Host: host, Port: port, ConnectionMode: mode}
		err := NewSQLServerConnector().TestConnection(ctx(t), p, "")
		if err != nil && err.Error() == "connection endpoint resolver is unavailable" {
			t.Fatalf("mode %q must not require a resolver", mode)
		}
		if accepted.Load() == 0 {
			t.Fatalf("mode %q did not dial the profile destination", mode)
		}
	}
}
