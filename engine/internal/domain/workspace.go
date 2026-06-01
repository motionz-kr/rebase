package domain

import (
	"errors"
	"time"
)

type Workspace struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	RemoteID  *string    `json:"remoteId"`
	Version   int        `json:"version"`
	SyncState string     `json:"syncState"` // local, synced, pending
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
}

func (w Workspace) Validate() error {
	if w.ID == "" {
		return errors.New("workspace ID is required")
	}
	if w.Name == "" {
		return errors.New("workspace name is required")
	}
	if w.SyncState != "local" && w.SyncState != "synced" && w.SyncState != "pending" {
		return errors.New("invalid sync state: " + w.SyncState)
	}
	return nil
}

type SavedQuery struct {
	ID          string     `json:"id"`
	WorkspaceID string     `json:"workspaceId"`
	ProfileID   string     `json:"profileId"`
	Name        string     `json:"name"`
	QueryText   string     `json:"queryText"`
	IsFavorite  bool       `json:"isFavorite"`
	RemoteID    *string    `json:"remoteId"`
	Version     int        `json:"version"`
	SyncState   string     `json:"syncState"`
	CreatedAt   time.Time  `json:"createdAt"`
	UpdatedAt   time.Time  `json:"updatedAt"`
}

func (q SavedQuery) Validate() error {
	if q.ID == "" {
		return errors.New("saved query ID is required")
	}
	if q.WorkspaceID == "" {
		return errors.New("workspace ID is required")
	}
	if q.ProfileID == "" {
		return errors.New("profile ID is required")
	}
	if q.Name == "" {
		return errors.New("saved query name is required")
	}
	if q.QueryText == "" {
		return errors.New("query text is required")
	}
	if q.SyncState != "local" && q.SyncState != "synced" && q.SyncState != "pending" {
		return errors.New("invalid sync state: " + q.SyncState)
	}
	return nil
}

type QueryHistory struct {
	ID           string     `json:"id"`
	WorkspaceID  string     `json:"workspaceId"`
	ProfileID    string     `json:"profileId"`
	QueryText    string     `json:"queryText"`
	ExecutedAt   time.Time  `json:"executedAt"`
	DurationMs   int64      `json:"durationMs"`
	Success      bool       `json:"success"`
	ErrorMessage *string    `json:"errorMessage"`
	RowCount     *int64     `json:"rowCount"`
	RemoteID     *string    `json:"remoteId"`
	Version      int        `json:"version"`
	SyncState    string     `json:"syncState"`
}

func (h QueryHistory) Validate() error {
	if h.ID == "" {
		return errors.New("query history ID is required")
	}
	if h.WorkspaceID == "" {
		return errors.New("workspace ID is required")
	}
	if h.ProfileID == "" {
		return errors.New("profile ID is required")
	}
	if h.QueryText == "" {
		return errors.New("query text is required")
	}
	if h.SyncState != "local" && h.SyncState != "synced" && h.SyncState != "pending" {
		return errors.New("invalid sync state: " + h.SyncState)
	}
	return nil
}

// Phase 8 Models (Stubs / Account & MCP)
type Account struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Token     string    `json:"token"`
	CreatedAt time.Time `json:"createdAt"`
}

type TeamWorkspace struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	WorkspaceID string `json:"workspaceId"`
	Role        string `json:"role"` // owner, member, read-only
}

type MCPSettings struct {
	Enabled    bool     `json:"enabled"`
	AllowedDBs []string `json:"allowedDbs"` // Profile IDs
}

type MCPPolicy struct {
	ID         string `json:"id"`
	PolicyName string `json:"policyName"`
	Rule       string `json:"rule"` // read-only, full
}
