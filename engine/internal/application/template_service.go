package application

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type TemplateService struct {
	repo ports.TemplateRepository
}

func NewTemplateService(repo ports.TemplateRepository) *TemplateService {
	return &TemplateService{repo: repo}
}

func (s *TemplateService) SaveTemplate(ctx context.Context, id, workspaceID, name, description, category, sqlText, parameters, driver string) (*domain.Template, error) {
	if id == "" {
		id = uuid.NewString()
	}
	if parameters == "" {
		parameters = "[]"
	}
	t := &domain.Template{
		ID: id, WorkspaceID: workspaceID, Name: name, Description: description,
		Category: category, SQLText: sqlText, Parameters: parameters, Driver: driver,
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := t.Validate(); err != nil {
		return nil, err
	}
	if err := s.repo.Create(ctx, t); err != nil {
		return nil, err
	}
	return t, nil
}

func (s *TemplateService) ListTemplates(ctx context.Context, workspaceID string) ([]*domain.Template, error) {
	return s.repo.List(ctx, workspaceID)
}

func (s *TemplateService) DeleteTemplate(ctx context.Context, id string) error {
	return s.repo.Delete(ctx, id)
}
