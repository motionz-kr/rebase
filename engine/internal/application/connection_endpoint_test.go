package application

import (
	"context"
	"errors"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type fakeTunnel struct {
	calls  int
	closed []string
	err    error
}

func (f *fakeTunnel) ResolveEndpoint(context.Context, domain.ConnectionProfile) (ports.ConnectionEndpoint, error) {
	f.calls++
	return ports.ConnectionEndpoint{Host: "127.0.0.1", Port: 15432}, f.err
}
func (f *fakeTunnel) CloseProfile(id string) { f.closed = append(f.closed, id) }
func TestConnectionEndpointResolution(t *testing.T) {
	svc := NewConnectionService(ports.NewFakeProfileRepository(), ports.NewFakeSecretStore())
	p := domain.ConnectionProfile{ID: "p", Name: "prod", Driver: "mysql", Host: "db.internal", Port: 3306, Database: "app"}
	ep, err := svc.ResolveEndpoint(context.Background(), p)
	if err != nil || ep.Host != p.Host || ep.Port != p.Port {
		t.Fatal(ep, err)
	}
	p.ConnectionMode = "ssm"
	p.SSM = &domain.SSMConfig{Region: "ap-northeast-2", InstanceID: "i-0123456789abcdef0"}
	if _, err = svc.ResolveEndpoint(context.Background(), p); err == nil {
		t.Fatal("SSM must never fall back to direct")
	}
	tunnel := &fakeTunnel{}
	svc.SetTunnelManager(tunnel)
	ep, err = svc.ResolveEndpoint(context.Background(), p)
	if err != nil || ep.Port != 15432 || tunnel.calls != 1 || p.Host != "db.internal" {
		t.Fatal(ep, err)
	}
	tunnel.err = errors.New("SSO expired")
	if _, err = svc.ResolveEndpoint(context.Background(), p); err == nil {
		t.Fatal("must propagate tunnel failure")
	}
	if err = svc.CreateProfile(context.Background(), &p, ""); err != nil {
		t.Fatal(err)
	}
	p.SSM.Region = "us-east-1"
	if err = svc.UpdateProfile(context.Background(), &p, ""); err != nil {
		t.Fatal(err)
	}
	if err = svc.DeleteProfile(context.Background(), p.ID); err != nil {
		t.Fatal(err)
	}
	if len(tunnel.closed) != 2 || tunnel.closed[0] != p.ID {
		t.Fatal(tunnel.closed)
	}
}
