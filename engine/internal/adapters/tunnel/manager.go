// Package tunnel composes transport adapters without exposing them to application.
package tunnel

import (
	"context"
	"errors"

	"github.com/smlee/database-local-engine/engine/internal/adapters/cloudsql"
	"github.com/smlee/database-local-engine/engine/internal/adapters/ssh"
	"github.com/smlee/database-local-engine/engine/internal/adapters/ssm"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// route is one transport manager; an interface so tests can substitute fakes.
type route interface {
	ports.TunnelManager
	Close()
}

type Manager struct {
	ssm      route
	ssh      route
	cloudsql route
}

func NewManager() *Manager {
	return &Manager{ssm: ssm.NewManager(), ssh: ssh.NewManager(), cloudsql: cloudsql.NewManager()}
}

// closeOtherRoutes releases the profile's tunnels held by managers other than
// the target one, so changing a profile's route never leaves the old process
// running. It is a map lookup per manager when nothing is open.
func (m *Manager) closeOtherRoutes(id string, target route) {
	if id == "" {
		return
	}
	for _, r := range []route{m.ssm, m.ssh, m.cloudsql} {
		if r != target {
			r.CloseProfile(id)
		}
	}
}

func (m *Manager) ResolveEndpoint(ctx context.Context, p domain.ConnectionProfile) (ports.ConnectionEndpoint, error) {
	var target route
	switch p.ConnectionMode {
	case "ssm":
		target = m.ssm
	case "ssh":
		target = m.ssh
	case "gcp_cloudsql":
		target = m.cloudsql
	default:
		return ports.ConnectionEndpoint{}, errors.New("unsupported tunnel route")
	}
	m.closeOtherRoutes(p.ID, target)
	return target.ResolveEndpoint(ctx, p)
}
func (m *Manager) CloseProfile(id string) {
	m.ssm.CloseProfile(id)
	m.ssh.CloseProfile(id)
	m.cloudsql.CloseProfile(id)
}
func (m *Manager) Close() { m.ssm.Close(); m.ssh.Close(); m.cloudsql.Close() }
