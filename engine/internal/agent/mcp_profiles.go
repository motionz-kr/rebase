package agent

import (
	"context"
	"fmt"

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

// NewMultiProfileRegistry exposes one shared set of tools for multiple saved
// SQL connection profiles. Callers must pass only profiles enabled for MCP.
func NewMultiProfileRegistry(targets []MCPConnectionTarget) *Registry {
	r := &Registry{tools: map[string]Tool{}}
	byID := make(map[string]MCPConnectionTarget, len(targets))
	orderedTargets := make([]MCPConnectionTarget, 0, len(targets))
	for _, target := range targets {
		if target.ID == "" || target.Registry == nil {
			continue
		}
		if _, exists := byID[target.ID]; exists {
			continue
		}
		byID[target.ID] = target
		orderedTargets = append(orderedTargets, target)
	}

	r.add(Tool{
		Spec: ports.ToolSpec{
			Name:        "list_connections",
			Description: "List Rebase database connections enabled for MCP. Use a returned connectionId with every other tool.",
			Schema:      map[string]any{"type": "object", "properties": map[string]any{}},
		},
		Run: func(context.Context, map[string]any) (any, error) {
			connections := make([]map[string]any, 0, len(orderedTargets))
			for _, target := range orderedTargets {
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
	for _, target := range orderedTargets {
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
		spec.Schema = schemaWithConnectionID(spec.Schema)
		r.add(Tool{
			Spec: spec,
			Run: func(ctx context.Context, args map[string]any) (any, error) {
				connectionID := strArg(args, "connectionId")
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
