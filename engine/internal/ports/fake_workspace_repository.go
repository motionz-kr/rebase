package ports

import (
	"context"
	"errors"
	"sync"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type FakeWorkspaceRepository struct {
	mu         sync.RWMutex
	workspaces map[string]*domain.Workspace
	queries    map[string]*domain.SavedQuery
	history    map[string]*domain.QueryHistory
}

func NewFakeWorkspaceRepository() *FakeWorkspaceRepository {
	return &FakeWorkspaceRepository{
		workspaces: make(map[string]*domain.Workspace),
		queries:    make(map[string]*domain.SavedQuery),
		history:    make(map[string]*domain.QueryHistory),
	}
}

func (r *FakeWorkspaceRepository) SaveWorkspace(ctx context.Context, ws *domain.Workspace) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.workspaces[ws.ID] = ws
	return nil
}

func (r *FakeWorkspaceRepository) GetWorkspace(ctx context.Context, id string) (*domain.Workspace, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ws, exists := r.workspaces[id]
	if !exists {
		return nil, errors.New("workspace not found")
	}
	return ws, nil
}

func (r *FakeWorkspaceRepository) DeleteWorkspace(ctx context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.workspaces, id)
	return nil
}

func (r *FakeWorkspaceRepository) ListWorkspaces(ctx context.Context) ([]*domain.Workspace, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	list := make([]*domain.Workspace, 0, len(r.workspaces))
	for _, ws := range r.workspaces {
		list = append(list, ws)
	}
	return list, nil
}

func (r *FakeWorkspaceRepository) SaveQuery(ctx context.Context, q *domain.SavedQuery) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.queries[q.ID] = q
	return nil
}

func (r *FakeWorkspaceRepository) GetQuery(ctx context.Context, id string) (*domain.SavedQuery, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	q, exists := r.queries[id]
	if !exists {
		return nil, errors.New("query not found")
	}
	return q, nil
}

func (r *FakeWorkspaceRepository) DeleteQuery(ctx context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.queries, id)
	return nil
}

func (r *FakeWorkspaceRepository) ListQueries(ctx context.Context, workspaceID string) ([]*domain.SavedQuery, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	list := make([]*domain.SavedQuery, 0)
	for _, q := range r.queries {
		if q.WorkspaceID == workspaceID {
			list = append(list, q)
		}
	}
	return list, nil
}

func (r *FakeWorkspaceRepository) AddHistory(ctx context.Context, h *domain.QueryHistory) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.history[h.ID] = h
	return nil
}

func (r *FakeWorkspaceRepository) GetHistory(ctx context.Context, id string) (*domain.QueryHistory, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	h, exists := r.history[id]
	if !exists {
		return nil, errors.New("history not found")
	}
	return h, nil
}

func (r *FakeWorkspaceRepository) ListHistory(ctx context.Context, workspaceID string, profileID string) ([]*domain.QueryHistory, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	list := make([]*domain.QueryHistory, 0)
	for _, h := range r.history {
		if h.WorkspaceID == workspaceID && h.ProfileID == profileID {
			list = append(list, h)
		}
	}
	return list, nil
}
