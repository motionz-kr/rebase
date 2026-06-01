package application

import (
	"context"
	"testing"
)

func TestCancellationRegistry(t *testing.T) {
	registry := NewCancellationRegistry()

	_, cancel := context.WithCancel(context.Background())
	defer cancel()

	info := &CancelInfo{
		SessionID: 999,
		ProfileID: "test-profile-id",
		Driver:    "mysql",
		CancelFn:  cancel,
	}

	registry.Register("query-1", info)

	retrieved, ok := registry.Get("query-1")
	if !ok {
		t.Fatal("expected query-1 to be registered")
	}
	if retrieved.SessionID != 999 {
		t.Errorf("expected session ID 999, got %d", retrieved.SessionID)
	}

	registry.Unregister("query-1")

	_, ok = registry.Get("query-1")
	if ok {
		t.Fatal("expected query-1 to be unregistered")
	}
}
