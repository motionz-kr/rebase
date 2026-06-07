package domain

import (
	"errors"
	"time"
)

// Template is a user-saved parameterized SQL task template.
type Template struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspaceId"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Category    string    `json:"category"`
	SQLText     string    `json:"sqlText"`
	Parameters  string    `json:"parameters"` // JSON array of param defs
	Driver      string    `json:"driver"`     // "" = any
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

func (t Template) Validate() error {
	if t.ID == "" {
		return errors.New("template ID is required")
	}
	if t.WorkspaceID == "" {
		return errors.New("workspace ID is required")
	}
	if t.Name == "" {
		return errors.New("template name is required")
	}
	if t.SQLText == "" {
		return errors.New("template SQL is required")
	}
	return nil
}
