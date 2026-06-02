package redis

import (
	"context"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func TestRedisConnector_Integration(t *testing.T) {
	connector := NewRedisConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	p := domain.ConnectionProfile{
		ID:       "redis-integration-1",
		Name:     "Redis Local",
		Driver:   "redis",
		Host:     "127.0.0.1",
		Port:     6379,
		Username: "",
		TLSMode:  "none",
	}

	err := connector.TestConnection(ctx, p, "")
	if err != nil {
		t.Fatalf("failed to connect to local Redis: %v", err)
	}
}

func TestRedisConnector_Mutations(t *testing.T) {
	connector := NewRedisConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	p := domain.ConnectionProfile{ID: "redis-mut-1", Driver: "redis", Host: "127.0.0.1", Port: 6379, TLSMode: "none"}
	pw := ""
	k := "rebase:test:mut"
	k2 := "rebase:test:mut2"
	connector.DeleteKey(ctx, p, pw, k)
	connector.DeleteKey(ctx, p, pw, k2)
	defer connector.DeleteKey(ctx, p, pw, k)
	defer connector.DeleteKey(ctx, p, pw, k2)

	// SET (string) + read back
	if err := connector.SetString(ctx, p, pw, k, "hello"); err != nil {
		t.Fatalf("SetString: %v", err)
	}
	v, err := connector.GetKeyValue(ctx, p, pw, k)
	if err != nil || !v.Exists || v.Value != "hello" || v.Type != "string" {
		t.Fatalf("after set: %+v err=%v", v, err)
	}

	// TTL set then clear (PERSIST)
	if err := connector.SetTTL(ctx, p, pw, k, 60); err != nil {
		t.Fatalf("SetTTL: %v", err)
	}
	if v, _ = connector.GetKeyValue(ctx, p, pw, k); v.TTL <= 0 || v.TTL > 60 {
		t.Errorf("expected ttl ~60, got %d", v.TTL)
	}
	if err := connector.SetTTL(ctx, p, pw, k, -1); err != nil {
		t.Fatalf("PERSIST: %v", err)
	}
	if v, _ = connector.GetKeyValue(ctx, p, pw, k); v.TTL != -1 {
		t.Errorf("expected ttl -1 after persist, got %d", v.TTL)
	}

	// RENAME
	if err := connector.RenameKey(ctx, p, pw, k, k2); err != nil {
		t.Fatalf("RenameKey: %v", err)
	}
	if v, _ = connector.GetKeyValue(ctx, p, pw, k2); !v.Exists || v.Value != "hello" {
		t.Errorf("after rename, new key: %+v", v)
	}
	if v, _ = connector.GetKeyValue(ctx, p, pw, k); v.Exists {
		t.Errorf("old key should be gone after rename")
	}

	// DELETE
	existed, err := connector.DeleteKey(ctx, p, pw, k2)
	if err != nil || !existed {
		t.Fatalf("DeleteKey: existed=%v err=%v", existed, err)
	}
	if v, _ = connector.GetKeyValue(ctx, p, pw, k2); v.Exists {
		t.Errorf("key should be gone after delete")
	}
}

func TestRedisConnector_RunCommand(t *testing.T) {
	connector := NewRedisConnector()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	p := domain.ConnectionProfile{ID: "redis-cmd-1", Driver: "redis", Host: "127.0.0.1", Port: 6379, TLSMode: "none"}
	pw := ""
	k := "rebase:test:cmd"
	connector.DeleteKey(ctx, p, pw, k)
	defer connector.DeleteKey(ctx, p, pw, k)

	// Status reply (SET → OK)
	r, err := connector.RunCommand(ctx, p, pw, []string{"SET", k, "v1"})
	if err != nil || r.IsError {
		t.Fatalf("SET: err=%v result=%+v", err, r)
	}
	if r.Output != "OK" {
		t.Errorf("SET output = %q, want OK", r.Output)
	}

	// Bulk string reply (GET → v1)
	r, _ = connector.RunCommand(ctx, p, pw, []string{"GET", k})
	if r.Output != "v1" {
		t.Errorf("GET output = %q, want v1", r.Output)
	}

	// Integer reply (STRLEN → 2)
	r, _ = connector.RunCommand(ctx, p, pw, []string{"STRLEN", k})
	if r.Output != "2" {
		t.Errorf("STRLEN output = %q, want 2", r.Output)
	}

	// nil reply (GET missing → (nil), not an error)
	r, _ = connector.RunCommand(ctx, p, pw, []string{"GET", "rebase:test:cmd:absent"})
	if r.IsError || r.Output != "(nil)" {
		t.Errorf("GET absent = %+v, want output (nil)", r)
	}

	// Redis-level error (INCR on a non-integer string) → IsError, no transport error
	r, err = connector.RunCommand(ctx, p, pw, []string{"INCR", k})
	if err != nil {
		t.Fatalf("INCR transport err: %v", err)
	}
	if !r.IsError {
		t.Errorf("INCR on string should report a redis error, got %+v", r)
	}
}
