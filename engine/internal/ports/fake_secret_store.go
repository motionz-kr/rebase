package ports

import (
	"context"
	"errors"
	"sync"
)

type FakeSecretStore struct {
	mu      sync.RWMutex
	secrets map[string]string
}

func NewFakeSecretStore() *FakeSecretStore {
	return &FakeSecretStore{
		secrets: make(map[string]string),
	}
}

func (s *FakeSecretStore) Get(ctx context.Context, key string) (string, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	val, exists := s.secrets[key]
	if !exists {
		return "", errors.New("secret not found")
	}
	return val, nil
}

func (s *FakeSecretStore) Set(ctx context.Context, key string, secret string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.secrets[key] = secret
	return nil
}

func (s *FakeSecretStore) Delete(ctx context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.secrets[key]; !exists {
		return errors.New("secret not found")
	}
	delete(s.secrets, key)
	return nil
}
