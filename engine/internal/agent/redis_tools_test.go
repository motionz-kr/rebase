package agent

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// fakeRedis implements redisReader with canned data.
type fakeRedis struct {
	scan        ports.RedisKeyspaceInfo
	value       ports.RedisValueInfo
	lastPattern string
	lastCursor  uint64
	lastCount   int64
	lastKey     string
}

func (f *fakeRedis) ScanKeys(_ context.Context, _ domain.ConnectionProfile, _ string, pattern string, cursor uint64, count int64) (ports.RedisKeyspaceInfo, error) {
	f.lastPattern = pattern
	f.lastCursor = cursor
	f.lastCount = count
	return f.scan, nil
}

func (f *fakeRedis) GetKeyValue(_ context.Context, _ domain.ConnectionProfile, _ string, key string) (ports.RedisValueInfo, error) {
	f.lastKey = key
	return f.value, nil
}

func TestRedisRegistryExposesOnlyReadTools(t *testing.T) {
	reg := NewRedisRegistry(&fakeRedis{}, domainProfile(), "")
	names := map[string]bool{}
	for _, s := range reg.Specs() {
		names[s.Name] = true
	}
	if !names["scan_keys"] || !names["get_value"] {
		t.Fatalf("expected scan_keys and get_value, got %v", names)
	}
	if len(names) != 2 {
		t.Fatalf("redis registry should expose exactly 2 read tools, got %v", names)
	}
	// No write/delete/command-exec tools.
	for _, bad := range []string{"set_value", "set_string", "delete_key", "del", "rename_key", "set_ttl", "run_command"} {
		if names[bad] {
			t.Errorf("redis registry must NOT expose write tool %q", bad)
		}
	}
}

func TestRedisScanKeys(t *testing.T) {
	conn := &fakeRedis{scan: ports.RedisKeyspaceInfo{Keys: []string{"user:1", "user:2"}, Cursor: 42}}
	reg := NewRedisRegistry(conn, domainProfile(), "")

	out, err := reg.Dispatch(context.Background(), "scan_keys", map[string]any{"pattern": "user:*", "count": float64(10)})
	if err != nil {
		t.Fatalf("scan_keys: %v", err)
	}
	if conn.lastPattern != "user:*" || conn.lastCount != 10 || conn.lastCursor != 0 {
		t.Errorf("scan_keys args wrong: pattern=%q count=%d cursor=%d", conn.lastPattern, conn.lastCount, conn.lastCursor)
	}
	b, _ := json.Marshal(out)
	s := string(b)
	if !containsSub(s, "user:1") || !containsSub(s, `"cursor":42`) {
		t.Errorf("scan_keys result wrong: %s", s)
	}
}

func TestRedisScanKeysDefaults(t *testing.T) {
	conn := &fakeRedis{}
	reg := NewRedisRegistry(conn, domainProfile(), "")
	if _, err := reg.Dispatch(context.Background(), "scan_keys", map[string]any{}); err != nil {
		t.Fatalf("scan_keys: %v", err)
	}
	if conn.lastPattern != "*" {
		t.Errorf("default pattern should be *, got %q", conn.lastPattern)
	}
	if conn.lastCount != 100 {
		t.Errorf("default count should be 100, got %d", conn.lastCount)
	}
}

func TestRedisGetValue(t *testing.T) {
	conn := &fakeRedis{value: ports.RedisValueInfo{Type: "string", Value: "hello", TTL: -1, Exists: true}}
	reg := NewRedisRegistry(conn, domainProfile(), "")

	out, err := reg.Dispatch(context.Background(), "get_value", map[string]any{"key": "greeting"})
	if err != nil {
		t.Fatalf("get_value: %v", err)
	}
	if conn.lastKey != "greeting" {
		t.Errorf("get_value should request key greeting, got %q", conn.lastKey)
	}
	b, _ := json.Marshal(out)
	s := string(b)
	if !containsSub(s, `"type":"string"`) || !containsSub(s, `"value":"hello"`) || !containsSub(s, `"exists":true`) {
		t.Errorf("get_value result wrong: %s", s)
	}
}
