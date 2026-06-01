package application

import (
	"context"
	"sync"
)

type CancelInfo struct {
	SessionID int64 // For server-side query kill (MySQL connection_id or Postgres pid)
	ProfileID string
	Driver    string
	CancelFn  context.CancelFunc
}

type CancellationRegistry struct {
	mu       sync.RWMutex
	registry map[string]*CancelInfo
}

func NewCancellationRegistry() *CancellationRegistry {
	return &CancellationRegistry{
		registry: make(map[string]*CancelInfo),
	}
}

func (r *CancellationRegistry) Register(queryID string, info *CancelInfo) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.registry[queryID] = info
}

func (r *CancellationRegistry) Unregister(queryID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.registry, queryID)
}

func (r *CancellationRegistry) Get(queryID string) (*CancelInfo, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	info, ok := r.registry[queryID]
	return info, ok
}
