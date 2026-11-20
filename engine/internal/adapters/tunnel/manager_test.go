package tunnel

import (
	"context"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type fakeRoute struct {
	name     string
	resolved []string
	closed   []string
}

func (f *fakeRoute) ResolveEndpoint(_ context.Context, p domain.ConnectionProfile) (ports.ConnectionEndpoint, error) {
	f.resolved = append(f.resolved, p.ID)
	return ports.ConnectionEndpoint{Host: "127.0.0.1", Port: 1}, nil
}
func (f *fakeRoute) CloseProfile(id string) { f.closed = append(f.closed, id) }
func (f *fakeRoute) Close()                 {}

func newFakes() (*Manager, *fakeRoute, *fakeRoute, *fakeRoute) {
	a, b, c := &fakeRoute{}, &fakeRoute{}, &fakeRoute{}
	return &Manager{ssm: a, ssh: b, cloudsql: c}, a, b, c
}

func TestResolveClosesOtherRoutesOnly(t *testing.T) {
	m, ssm, ssh, csql := newFakes()
	if _, err := m.ResolveEndpoint(context.Background(), domain.ConnectionProfile{ID: "p1", ConnectionMode: "ssh"}); err != nil {
		t.Fatal(err)
	}
	if len(ssh.resolved) != 1 || len(ssh.closed) != 0 {
		t.Fatalf("target manager: resolved=%v closed=%v", ssh.resolved, ssh.closed)
	}
	for name, r := range map[string]*fakeRoute{"ssm": ssm, "cloudsql": csql} {
		if len(r.closed) != 1 || r.closed[0] != "p1" || len(r.resolved) != 0 {
			t.Errorf("%s: closed=%v resolved=%v", name, r.closed, r.resolved)
		}
	}
}

func TestResolveFromCloudSQLClosesFormerRouteEntriesOfSameProfileOnly(t *testing.T) {
	m, ssm, ssh, csql := newFakes()
	if _, err := m.ResolveEndpoint(context.Background(), domain.ConnectionProfile{ID: "p1", ConnectionMode: "ssm"}); err != nil {
		t.Fatal(err)
	}
	if len(csql.closed) != 1 || csql.closed[0] != "p1" {
		t.Fatalf("cloudsql closed = %v", csql.closed)
	}
	for _, r := range []*fakeRoute{ssm, ssh, csql} {
		for _, id := range r.closed {
			if id != "p1" {
				t.Fatalf("another profile touched: %v", r.closed)
			}
		}
	}
}

func TestResolveWithoutIDClosesNothing(t *testing.T) {
	m, ssm, ssh, csql := newFakes()
	if _, err := m.ResolveEndpoint(context.Background(), domain.ConnectionProfile{ConnectionMode: "gcp_cloudsql"}); err != nil {
		t.Fatal(err)
	}
	if len(ssm.closed)+len(ssh.closed)+len(csql.closed) != 0 {
		t.Fatal("unsaved test routes must not close anything")
	}
}
