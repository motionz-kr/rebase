package agent

import (
	"context"
	"fmt"
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// MCPConnectionTarget binds one MCP-enabled Rebase connection to its policy-
// enforcing tool registry. The multi-profile registry adds explicit routing
// without combining the underlying connection policies.
type MCPConnectionTarget struct {
	ID       string
	Name     string
	Driver   string
	Database string
	Registry *Registry
}

type MCPConnectionTargetResolver func(context.Context) ([]MCPConnectionTarget, error)
type MCPConnectionProfileLister func(context.Context) ([]domain.ConnectionProfile, error)

// NewMultiProfileRegistry exposes one shared set of tools for multiple saved
// SQL connection profiles. Callers must pass only profiles enabled for MCP.
func NewMultiProfileRegistry(targets []MCPConnectionTarget) *Registry {
	return newMultiProfileRegistry(targets, nil)
}

func newMultiProfileRegistry(specTargets []MCPConnectionTarget, resolve MCPConnectionTargetResolver) *Registry {
	r := &Registry{tools: map[string]Tool{}}
	staticTargets := uniqueMCPConnectionTargets(specTargets)
	staticByID := indexMCPConnectionTargets(staticTargets)
	loadTargets := func(ctx context.Context) (map[string]MCPConnectionTarget, []MCPConnectionTarget, error) {
		if resolve == nil {
			return staticByID, staticTargets, nil
		}
		targets, err := resolve(ctx)
		if err != nil {
			return nil, nil, err
		}
		targets = uniqueMCPConnectionTargets(targets)
		return indexMCPConnectionTargets(targets), targets, nil
	}

	r.add(Tool{
		Spec: ports.ToolSpec{
			Name:        "list_connections",
			Description: "List Rebase database connections enabled for MCP. Use a returned connectionId with every other tool.",
			Schema:      map[string]any{"type": "object", "properties": map[string]any{}},
		},
		Run: func(ctx context.Context, _ map[string]any) (any, error) {
			_, targets, err := loadTargets(ctx)
			if err != nil {
				return nil, err
			}
			connections := make([]map[string]any, 0, len(targets))
			for _, target := range targets {
				connections = append(connections, map[string]any{
					"connectionId": target.ID,
					"name":         target.Name,
					"driver":       target.Driver,
					"database":     target.Database,
				})
			}
			return connections, nil
		},
	})

	// The public tool list is the union of capabilities configured on the
	// exposed profiles. The selected profile's own registry remains the final
	// authority when a client attempts to use a policy-specific tool.
	specs := make(map[string]ports.ToolSpec)
	var order []string
	for _, target := range staticTargets {
		for _, spec := range target.Registry.Specs() {
			if _, exists := specs[spec.Name]; exists {
				continue
			}
			specs[spec.Name] = spec
			order = append(order, spec.Name)
		}
	}

	for _, name := range order {
		toolName := name
		spec := specs[toolName]
		spec.Description += " Requires connectionId from list_connections; the selected connection's MCP permissions apply."
		if toolName == "execute_write" {
			spec.Description += " Always listed for clients that cache tools; the engine permits it only when the selected profile currently has full_access and is not read-only."
		}
		if toolName == "write_proposal_status" {
			spec.Description += " Always listed for clients that cache tools; it works only for an approval_required selected profile."
		}
		spec.Schema = schemaWithConnectionID(spec.Schema)
		r.add(Tool{
			Spec: spec,
			Run: func(ctx context.Context, args map[string]any) (any, error) {
				connectionID := strArg(args, "connectionId")
				byID, _, err := loadTargets(ctx)
				if err != nil {
					return nil, err
				}
				target, ok := byID[connectionID]
				if !ok {
					return nil, fmt.Errorf("MCP connection not found or not enabled: %s", connectionID)
				}
				if _, ok := target.Registry.tools[toolName]; !ok {
					return nil, fmt.Errorf("tool %q is not enabled for selected connection %q", toolName, target.Name)
				}
				delegatedArgs := make(map[string]any, len(args))
				for key, value := range args {
					if key != "connectionId" {
						delegatedArgs[key] = value
					}
				}
				return target.Registry.Dispatch(ctx, toolName, delegatedArgs)
			},
		})
	}
	return r
}

func uniqueMCPConnectionTargets(targets []MCPConnectionTarget) []MCPConnectionTarget {
	byID := make(map[string]MCPConnectionTarget, len(targets))
	ordered := make([]MCPConnectionTarget, 0, len(targets))
	for _, target := range targets {
		if target.ID == "" || target.Registry == nil {
			continue
		}
		if _, exists := byID[target.ID]; exists {
			continue
		}
		byID[target.ID] = target
		ordered = append(ordered, target)
	}
	return ordered
}

func indexMCPConnectionTargets(targets []MCPConnectionTarget) map[string]MCPConnectionTarget {
	byID := make(map[string]MCPConnectionTarget, len(targets))
	for _, target := range targets {
		byID[target.ID] = target
	}
	return byID
}

// NewMultiProfileRegistryWithDiscovery adds one read-only local discovery tool
// to the shared registry. It never accepts a host or port from the caller.
func NewMultiProfileRegistryWithDiscovery(targets []MCPConnectionTarget, discovery ports.DatabaseDiscovery) *Registry {
	return NewMultiProfileRegistryWithManagement(targets, nil, discovery, nil, nil)
}

// NewMultiProfileRegistryWithManagement adds local discovery and reviewed
// profile-management proposals. A resolver can refresh MCP-enabled targets on
// every call while the advertised SQL tool set remains stable for clients that
// cache tools/list results.
func NewMultiProfileRegistryWithManagement(
	specTargets []MCPConnectionTarget,
	resolve MCPConnectionTargetResolver,
	discovery ports.DatabaseDiscovery,
	proposals ports.MCPConnectionProposalUseCase,
	listProfiles MCPConnectionProfileLister,
) *Registry {
	r := newMultiProfileRegistry(specTargets, resolve)
	if discovery != nil {
		r.add(Tool{
			Spec: ports.ToolSpec{
				Name:        "discover_local_databases",
				Description: "Find supported database services reachable on this PC. Searches loopback ports and locally published Docker ports; returns no credentials.",
				Schema:      map[string]any{"type": "object", "properties": map[string]any{}},
			},
			Run: func(ctx context.Context, _ map[string]any) (any, error) {
				return discovery.Discover(ctx)
			},
		})
	}
	if proposals != nil {
		r.add(Tool{
			Spec: ports.ToolSpec{
				Name:        "propose_connection_profile",
				Description: "Request a MySQL, PostgreSQL, or SQL Server connection profile create/update. First call discover_local_databases and use its candidateId. The user must review, enter credentials, test, and save in Rebase. This tool cannot choose an endpoint or set MCP permissions.",
				Schema: map[string]any{
					"type": "object",
					"properties": map[string]any{
						"operation":       map[string]any{"type": "string", "enum": []string{domain.MCPConnectionProposalCreate, domain.MCPConnectionProposalUpdate}},
						"candidateId":     map[string]any{"type": "string"},
						"targetProfileId": map[string]any{"type": "string", "description": "Required only when operation is update."},
						"name":            map[string]any{"type": "string"},
						"database":        map[string]any{"type": "string"},
						"username":        map[string]any{"type": "string"},
						"tlsMode":         map[string]any{"type": "string", "enum": []string{"none", "prefer", "require"}},
					},
					"required":             []string{"operation", "candidateId"},
					"additionalProperties": false,
				},
			},
			Run: func(ctx context.Context, args map[string]any) (any, error) {
				allowed := map[string]bool{"operation": true, "candidateId": true, "targetProfileId": true, "name": true, "database": true, "username": true, "tlsMode": true}
				for key := range args {
					if !allowed[key] {
						return nil, fmt.Errorf("unsupported connection proposal field: %s", key)
					}
				}
				return proposals.Propose(ctx, domain.MCPConnectionProposal{
					Operation: strArg(args, "operation"), CandidateID: strArg(args, "candidateId"),
					TargetProfileID: strArg(args, "targetProfileId"), Name: strings.TrimSpace(strArg(args, "name")),
					Database: strArg(args, "database"), Username: strArg(args, "username"), TLSMode: strArg(args, "tlsMode"),
				})
			},
		})
	}
	if listProfiles != nil {
		r.add(Tool{
			Spec: ports.ToolSpec{
				Name:        "list_saved_connection_profiles",
				Description: "List saved Rebase connection profile details that may be targeted by propose_connection_profile. Credentials and secret references are omitted; permissions are read-only and cannot be changed by MCP.",
				Schema:      map[string]any{"type": "object", "properties": map[string]any{}},
			},
			Run: func(ctx context.Context, _ map[string]any) (any, error) {
				profiles, err := listProfiles(ctx)
				if err != nil {
					return nil, err
				}
				out := make([]map[string]any, 0, len(profiles))
				for _, profile := range profiles {
					out = append(out, map[string]any{
						"id": profile.ID, "name": profile.Name, "driver": profile.Driver,
						"host": profile.Host, "port": profile.Port, "database": profile.Database,
						"username": profile.Username, "mcpEnabled": profile.McpEnabled,
						"mcpWriteMode": domain.NormalizeMCPWriteMode(profile.McpWriteMode),
					})
				}
				return out, nil
			},
		})
	}
	return r
}

func schemaWithConnectionID(schema map[string]any) map[string]any {
	cloned := map[string]any{"type": "object"}
	for key, value := range schema {
		if key != "properties" && key != "required" {
			cloned[key] = value
		}
	}

	properties := make(map[string]any)
	if existing, ok := schema["properties"].(map[string]any); ok {
		for key, value := range existing {
			properties[key] = value
		}
	}
	properties["connectionId"] = map[string]any{
		"type":        "string",
		"description": "Exact connectionId returned by list_connections.",
	}
	cloned["properties"] = properties

	required := []string{"connectionId"}
	switch values := schema["required"].(type) {
	case []string:
		for _, name := range values {
			if name != "connectionId" {
				required = append(required, name)
			}
		}
	case []any:
		for _, value := range values {
			if name, ok := value.(string); ok {
				if name != "connectionId" {
					required = append(required, name)
				}
			}
		}
	}
	cloned["required"] = required
	return cloned
}
