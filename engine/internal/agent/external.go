package agent

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// McpCaller is the slice of an MCP client AttachMCPServers needs (so it can be
// faked in tests). *mcpclient.Client satisfies it. Public so the /agent/run
// handler can build a DialFunc.
type McpCaller interface {
	ListTools(ctx context.Context) ([]ports.ToolSpec, error)
	Call(ctx context.Context, name string, args map[string]any) (any, error)
	Close() error
}

// DialFunc opens a client for one server.
type DialFunc func(ctx context.Context, s domain.McpServer) (McpCaller, error)

// RegisterExternal adds an external (proxy) tool to the registry.
func (r *Registry) RegisterExternal(spec ports.ToolSpec, run func(ctx context.Context, args map[string]any) (any, error)) {
	r.add(Tool{Spec: spec, Run: run})
}

var nameSanitize = regexp.MustCompile(`[^a-z0-9_]+`)

func sanitize(s string) string {
	return strings.Trim(nameSanitize.ReplaceAllString(strings.ToLower(s), "_"), "_")
}

// AttachMCPServers dials each enabled server, lists its tools, and registers
// them as `mcp__<server>__<tool>` proxies. Trusted servers execute immediately;
// untrusted ones return a proposal (propose model). Failed servers are skipped
// with a warning. The returned cleanup closes all opened clients.
func AttachMCPServers(ctx context.Context, reg *Registry, servers []domain.McpServer, dial DialFunc) (func(), []string) {
	var clients []McpCaller
	var warnings []string
	cleanup := func() {
		for _, c := range clients {
			_ = c.Close()
		}
	}
	for _, s := range servers {
		if !s.Enabled {
			continue
		}
		client, err := dial(ctx, s)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("MCP 서버 %q 연결 실패: %v", s.Name, err))
			continue
		}
		clients = append(clients, client)
		specs, err := client.ListTools(ctx)
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("MCP 서버 %q 도구 목록 실패: %v", s.Name, err))
			continue
		}
		serverSlug := sanitize(s.Name)
		for _, sp := range specs {
			toolName := sp.Name
			proxyName := fmt.Sprintf("mcp__%s__%s", serverSlug, sanitize(toolName))
			spec := ports.ToolSpec{
				Name:        proxyName,
				Description: fmt.Sprintf("[외부:%s] %s", s.Name, sp.Description),
				Schema:      sp.Schema,
			}
			if s.Trusted {
				c := client
				reg.RegisterExternal(spec, func(ctx context.Context, args map[string]any) (any, error) {
					return c.Call(ctx, toolName, args)
				})
			} else {
				serverName := s.Name
				serverID := s.ID
				reg.RegisterExternal(spec, func(ctx context.Context, args map[string]any) (any, error) {
					return map[string]any{
						"proposed": true,
						"server":   serverName,
						"serverId": serverID,
						"tool":     toolName,
						"args":     args,
						"trusted":  false,
					}, nil
				})
			}
		}
	}
	return cleanup, warnings
}
