package agent

import (
	"context"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// redisReader is the read-only subset of ports.RedisConnector the agent tools
// need (kept small so tests can fake it without implementing the full
// connector, and so no write command can ever be reached from here).
type redisReader interface {
	ScanKeys(ctx context.Context, p domain.ConnectionProfile, password string, pattern string, cursor uint64, count int64) (ports.RedisKeyspaceInfo, error)
	GetKeyValue(ctx context.Context, p domain.ConnectionProfile, password string, key string) (ports.RedisValueInfo, error)
}

// NewRedisRegistry builds the read-only tool set bound to one Redis connection
// profile. By construction it exposes no write, delete, or command-exec tools.
func NewRedisRegistry(conn redisReader, p domain.ConnectionProfile, password string) *Registry {
	r := &Registry{tools: map[string]Tool{}}

	r.add(Tool{
		Spec: ports.ToolSpec{
			Name:        "scan_keys",
			Description: "Scan Redis keys matching a glob pattern (read-only).",
			Schema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"pattern": map[string]any{"type": "string"},
					"count":   map[string]any{"type": "integer"},
				},
			},
		},
		Run: func(ctx context.Context, args map[string]any) (any, error) {
			pattern := strArg(args, "pattern")
			if pattern == "" {
				pattern = "*"
			}
			count := intArg(args, "count", 100)
			info, err := conn.ScanKeys(ctx, p, password, pattern, 0, count)
			if err != nil {
				return nil, err
			}
			return map[string]any{"keys": info.Keys, "cursor": info.Cursor}, nil
		},
	})

	r.add(Tool{
		Spec: ports.ToolSpec{
			Name:        "get_value",
			Description: "Get a Redis key's type, TTL, and value (read-only).",
			Schema: map[string]any{
				"type":       "object",
				"properties": map[string]any{"key": map[string]any{"type": "string"}},
				"required":   []string{"key"},
			},
		},
		Run: func(ctx context.Context, args map[string]any) (any, error) {
			info, err := conn.GetKeyValue(ctx, p, password, strArg(args, "key"))
			if err != nil {
				return nil, err
			}
			return map[string]any{
				"type":   info.Type,
				"value":  info.Value,
				"ttl":    info.TTL,
				"exists": info.Exists,
			}, nil
		},
	})

	return r
}
