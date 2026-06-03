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

// agentKeyRef namespaces an agent provider's API key inside the SecretStore so
// it lives in the OS keychain alongside connection passwords (issue #10:
// "key in keychain"), never in renderer localStorage.
func agentKeyRef(provider string) string { return "agent-api-key:" + provider }

// SetAgentKey stores a provider's API key in the keychain.
func (s *ConnectionService) SetAgentKey(ctx context.Context, provider, key string) error {
	if provider == "" {
		return fmt.Errorf("provider is required")
	}
	return s.store.Set(ctx, agentKeyRef(provider), key)
}

// GetAgentKey returns a provider's stored API key (empty string + error if none).
func (s *ConnectionService) GetAgentKey(ctx context.Context, provider string) (string, error) {
	return s.store.Get(ctx, agentKeyRef(provider))
}

// ClearAgentKey removes a provider's stored API key.
func (s *ConnectionService) ClearAgentKey(ctx context.Context, provider string) error {
	return s.store.Delete(ctx, agentKeyRef(provider))
}

// HasAgentKey reports whether a non-empty key is stored for the provider.
func (s *ConnectionService) HasAgentKey(ctx context.Context, provider string) bool {
	v, err := s.GetAgentKey(ctx, provider)
	return err == nil && v != ""
}

// SetMCPConnectionSettings toggles MCP exposure + data-exposure for a profile.
func (s *ConnectionService) SetMCPConnectionSettings(ctx context.Context, id string, enabled bool, dataExposure string) error {
	p, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return err
	}
	if dataExposure == "" {
		dataExposure = "metadata"
	}
	p.McpEnabled = enabled
	p.McpDataExposure = dataExposure
	return s.repo.Update(ctx, p)
}

type ConnectionProfileService = ConnectionService
