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
