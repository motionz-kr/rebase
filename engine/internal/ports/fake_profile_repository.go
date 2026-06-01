package ports

import (
	"context"
	"errors"
	"sync"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type FakeProfileRepository struct {
	mu       sync.RWMutex
	profiles map[string]domain.ConnectionProfile
}

func NewFakeProfileRepository() *FakeProfileRepository {
	return &FakeProfileRepository{
		profiles: make(map[string]domain.ConnectionProfile),
	}
}

func (r *FakeProfileRepository) Create(ctx context.Context, p *domain.ConnectionProfile) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.profiles[p.ID]; exists {
		return errors.New("profile already exists")
	}
	r.profiles[p.ID] = *p
	return nil
}

func (r *FakeProfileRepository) GetByID(ctx context.Context, id string) (*domain.ConnectionProfile, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, exists := r.profiles[id]
	if !exists {
		return nil, errors.New("profile not found")
	}
	pCopy := p
	return &pCopy, nil
}

func (r *FakeProfileRepository) List(ctx context.Context) ([]domain.ConnectionProfile, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var list []domain.ConnectionProfile
	for _, p := range r.profiles {
		list = append(list, p)
	}
	return list, nil
}

func (r *FakeProfileRepository) Update(ctx context.Context, p *domain.ConnectionProfile) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.profiles[p.ID]; !exists {
		return errors.New("profile not found")
	}
	r.profiles[p.ID] = *p
	return nil
}

func (r *FakeProfileRepository) Delete(ctx context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.profiles[id]; !exists {
		return errors.New("profile not found")
	}
	delete(r.profiles, id)
	return nil
}
