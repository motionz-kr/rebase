// Package tunnel composes transport adapters without exposing them to application.
package tunnel

import (
	"context"
	"errors"

	"github.com/smlee/database-local-engine/engine/internal/adapters/ssh"
	"github.com/smlee/database-local-engine/engine/internal/adapters/ssm"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type Manager struct {
	ssm *ssm.Manager
	ssh *ssh.Manager
}

func NewManager() *Manager { return &Manager{ssm: ssm.NewManager(), ssh: ssh.NewManager()} }
func (m *Manager) ResolveEndpoint(ctx context.Context, p domain.ConnectionProfile) (ports.ConnectionEndpoint, error) {
	switch p.ConnectionMode {
	case "ssm":
		return m.ssm.ResolveEndpoint(ctx, p)
	case "ssh":
		return m.ssh.ResolveEndpoint(ctx, p)
	default:
		return ports.ConnectionEndpoint{}, errors.New("unsupported tunnel route")
	}
}
func (m *Manager) CloseProfile(id string) { m.ssm.CloseProfile(id); m.ssh.CloseProfile(id) }
func (m *Manager) Close()                 { m.ssm.Close(); m.ssh.Close() }
