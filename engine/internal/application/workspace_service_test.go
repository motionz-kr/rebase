package application

import (
	"context"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

func TestWorkspaceService(t *testing.T) {
	ctx := context.Background()
	repo := ports.NewFakeWorkspaceRepository()
	service := NewWorkspaceService(repo)

	t.Run("Create Workspace & Save Query", func(t *testing.T) {
		ws, err := service.SaveWorkspace(ctx, "ws-1", "Default Workspace")
		if err != nil {
			t.Fatalf("failed to create workspace: %v", err)
		}
		if ws.Name != "Default Workspace" {
			t.Errorf("expected name 'Default Workspace', got '%s'", ws.Name)
		}

		q, err := service.SaveQuery(ctx, "q-1", "ws-1", "prof-1", "My Query", "SELECT 1", true)
		if err != nil {
			t.Fatalf("failed to save query: %v", err)
		}
		if !q.IsFavorite {
			t.Error("expected query to be favorite")
		}

		queries, err := service.ListQueries(ctx, "ws-1")
		if err != nil {
			t.Fatalf("failed to list queries: %v", err)
		}
		if len(queries) != 1 {
			t.Errorf("expected 1 query, got %d", len(queries))
		}
	})

	t.Run("Add & List Query History", func(t *testing.T) {
		rowCount := int64(5)
		h, err := service.AddHistory(ctx, "ws-1", "prof-1", "SELECT 1", 100, true, nil, &rowCount)
		if err != nil {
			t.Fatalf("failed to add history: %v", err)
		}
		if h.DurationMs != 100 {
			t.Errorf("expected duration 100, got %d", h.DurationMs)
		}

		histories, err := service.ListHistory(ctx, "ws-1", "prof-1")
		if err != nil {
			t.Fatalf("failed to list history: %v", err)
		}
		if len(histories) != 1 {
			t.Errorf("expected 1 history entry, got %d", len(histories))
		}
	})
}
