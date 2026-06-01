package application

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type ConnectionService struct {
	repo           ports.ProfileRepository
	store          ports.SecretStore
	CancelRegistry *CancellationRegistry
}

func NewConnectionService(repo ports.ProfileRepository, store ports.SecretStore) *ConnectionService {
	return &ConnectionService{
		repo:           repo,
		store:          store,
		CancelRegistry: NewCancellationRegistry(),
	}
}

func (s *ConnectionService) CreateProfile(ctx context.Context, p *domain.ConnectionProfile, password string) error {
	if p.ID == "" {
		p.ID = uuid.New().String()
	}

	if err := p.Validate(); err != nil {
		return fmt.Errorf("invalid profile: %w", err)
	}

	p.SecretRef = fmt.Sprintf("secret-%s", p.ID)
	p.CreatedAt = time.Now()
	p.UpdatedAt = time.Now()

	// Store password in SecretStore
	if err := s.store.Set(ctx, p.SecretRef, password); err != nil {
		return fmt.Errorf("failed to save secret: %w", err)
	}

	// Store profile in repository
	if err := s.repo.Create(ctx, p); err != nil {
		// Attempt rollback of secret store
		_ = s.store.Delete(ctx, p.SecretRef)
		return fmt.Errorf("failed to save profile: %w", err)
	}

	return nil
}

func (s *ConnectionService) GetProfile(ctx context.Context, id string) (*domain.ConnectionProfile, string, error) {
	p, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return nil, "", err
	}

	password, err := s.store.Get(ctx, p.SecretRef)
	if err != nil {
		// Secret missing (e.g. Keychain cleared). Return empty password instead of failing usecase
		return p, "", nil
	}

	return p, password, nil
}

func (s *ConnectionService) ListProfiles(ctx context.Context) ([]domain.ConnectionProfile, error) {
	return s.repo.List(ctx)
}

func (s *ConnectionService) UpdateProfile(ctx context.Context, p *domain.ConnectionProfile, password string) error {
	if err := p.Validate(); err != nil {
		return fmt.Errorf("invalid profile: %w", err)
	}

	p.UpdatedAt = time.Now()

	// If a new password is provided, update it in SecretStore
	if password != "" {
		if err := s.store.Set(ctx, p.SecretRef, password); err != nil {
			return fmt.Errorf("failed to update secret: %w", err)
		}
	}

	if err := s.repo.Update(ctx, p); err != nil {
		return fmt.Errorf("failed to update profile: %w", err)
	}

	return nil
}

func (s *ConnectionService) DeleteProfile(ctx context.Context, id string) error {
	p, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return err
	}

	// Delete secret from store
	_ = s.store.Delete(ctx, p.SecretRef)

	// Delete profile from repo
	if err := s.repo.Delete(ctx, id); err != nil {
		return fmt.Errorf("failed to delete profile: %w", err)
	}

	return nil
}
type ConnectionProfileService = ConnectionService
