package ports

import (
	"context"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func VerifyWorkspaceRepositoryContract(t *testing.T, repo WorkspaceRepository) {
	ctx := context.Background()

	ws1 := &domain.Workspace{
		ID:        "ws-1",
		Name:      "Dev Workspace",
		SyncState: "local",
		CreatedAt: time.Now().Round(time.Second),
		UpdatedAt: time.Now().Round(time.Second),
	}

	ws2 := &domain.Workspace{
		ID:        "ws-2",
		Name:      "Prod Workspace",
		SyncState: "local",
		CreatedAt: time.Now().Round(time.Second),
		UpdatedAt: time.Now().Round(time.Second),
	}

	t.Run("Workspace CRUD", func(t *testing.T) {
		// Save
		err := repo.SaveWorkspace(ctx, ws1)
		if err != nil {
			t.Fatalf("failed to save workspace: %v", err)
		}

		// Get
		got, err := repo.GetWorkspace(ctx, ws1.ID)
		if err != nil {
			t.Fatalf("failed to get workspace: %v", err)
		}
		if got.Name != ws1.Name {
			t.Errorf("expected workspace name %s, got %s", ws1.Name, got.Name)
		}

		// List
		err = repo.SaveWorkspace(ctx, ws2)
		if err != nil {
			t.Fatalf("failed to save second workspace: %v", err)
		}

		list, err := repo.ListWorkspaces(ctx)
		if err != nil {
			t.Fatalf("failed to list workspaces: %v", err)
		}
		if len(list) < 2 {
			t.Errorf("expected at least 2 workspaces, got %d", len(list))
		}

		// Delete
		err = repo.DeleteWorkspace(ctx, ws1.ID)
		if err != nil {
			t.Fatalf("failed to delete workspace: %v", err)
		}

		_, err = repo.GetWorkspace(ctx, ws1.ID)
		if err == nil {
			t.Error("expected error when getting deleted workspace, got nil")
		}
	})

	t.Run("SavedQuery CRUD", func(t *testing.T) {
		// Prepare a Workspace
		_ = repo.SaveWorkspace(ctx, ws2)

		q1 := &domain.SavedQuery{
			ID:          "q-1",
			WorkspaceID: ws2.ID,
			ProfileID:   "prof-1",
			Name:        "Get Users",
			QueryText:   "SELECT * FROM users",
			IsFavorite:  false,
			SyncState:   "local",
			CreatedAt:   time.Now().Round(time.Second),
			UpdatedAt:   time.Now().Round(time.Second),
		}

		q2 := &domain.SavedQuery{
			ID:          "q-2",
			WorkspaceID: ws2.ID,
			ProfileID:   "prof-1",
			Name:        "Get Admins",
			QueryText:   "SELECT * FROM admins",
			IsFavorite:  true,
			SyncState:   "local",
			CreatedAt:   time.Now().Round(time.Second),
			UpdatedAt:   time.Now().Round(time.Second),
		}

		// Save
		err := repo.SaveQuery(ctx, q1)
		if err != nil {
			t.Fatalf("failed to save query: %v", err)
		}
		err = repo.SaveQuery(ctx, q2)
		if err != nil {
			t.Fatalf("failed to save second query: %v", err)
		}

		// Get
		got, err := repo.GetQuery(ctx, q1.ID)
		if err != nil {
			t.Fatalf("failed to get query: %v", err)
		}
		if got.Name != q1.Name || got.QueryText != q1.QueryText || got.IsFavorite != q1.IsFavorite {
			t.Errorf("query content mismatch: %+v vs %+v", got, q1)
		}

		// List
		queries, err := repo.ListQueries(ctx, ws2.ID)
		if err != nil {
			t.Fatalf("failed to list queries: %v", err)
		}
		if len(queries) != 2 {
			t.Errorf("expected 2 queries, got %d", len(queries))
		}

		// Update (Save existing)
		q1.Name = "Get Active Users"
		q1.IsFavorite = true
		err = repo.SaveQuery(ctx, q1)
		if err != nil {
			t.Fatalf("failed to update query: %v", err)
		}

		gotUpdated, err := repo.GetQuery(ctx, q1.ID)
		if err != nil {
			t.Fatalf("failed to get updated query: %v", err)
		}
		if gotUpdated.Name != "Get Active Users" || !gotUpdated.IsFavorite {
			t.Errorf("query updates not persisted: %+v", gotUpdated)
		}

		// Delete
		err = repo.DeleteQuery(ctx, q1.ID)
		if err != nil {
			t.Fatalf("failed to delete query: %v", err)
		}

		_, err = repo.GetQuery(ctx, q1.ID)
		if err == nil {
			t.Error("expected error getting deleted query, got nil")
		}
	})

	t.Run("QueryHistory Ops", func(t *testing.T) {
		_ = repo.SaveWorkspace(ctx, ws2)

		errStr := "syntax error"
		rowCount := int64(10)
		h1 := &domain.QueryHistory{
			ID:           "h-1",
			WorkspaceID:  ws2.ID,
			ProfileID:    "prof-1",
			QueryText:    "SELECT * FROM users",
			ExecutedAt:   time.Now().Round(time.Second),
			DurationMs:   120,
			Success:      true,
			ErrorMessage: nil,
			RowCount:     &rowCount,
			SyncState:    "local",
		}

		h2 := &domain.QueryHistory{
			ID:           "h-2",
			WorkspaceID:  ws2.ID,
			ProfileID:    "prof-1",
			QueryText:    "SELECT * FROM invalid_table",
			ExecutedAt:   time.Now().Round(time.Second),
			DurationMs:   45,
			Success:      false,
			ErrorMessage: &errStr,
			RowCount:     nil,
			SyncState:    "local",
		}

		// Add
		err := repo.AddHistory(ctx, h1)
		if err != nil {
			t.Fatalf("failed to add history: %v", err)
		}
		err = repo.AddHistory(ctx, h2)
		if err != nil {
			t.Fatalf("failed to add second history: %v", err)
		}

		// Get
		got, err := repo.GetHistory(ctx, h1.ID)
		if err != nil {
			t.Fatalf("failed to get history: %v", err)
		}
		if got.QueryText != h1.QueryText || got.DurationMs != h1.DurationMs || got.Success != h1.Success {
			t.Errorf("history mismatch: %+v vs %+v", got, h1)
		}

		// List
		historyList, err := repo.ListHistory(ctx, ws2.ID, "prof-1")
		if err != nil {
			t.Fatalf("failed to list history: %v", err)
		}
		if len(historyList) != 2 {
			t.Errorf("expected 2 history entries, got %d", len(historyList))
		}
	})
}
