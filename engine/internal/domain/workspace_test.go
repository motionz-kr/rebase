package domain

import (
	"testing"
	"time"
)

func TestWorkspace_Validate(t *testing.T) {
	tests := []struct {
		name    string
		ws      Workspace
		wantErr bool
	}{
		{
			name: "valid workspace",
			ws: Workspace{
				ID:        "ws-1",
				Name:      "Dev Workspace",
				SyncState: "local",
				CreatedAt: time.Now(),
				UpdatedAt: time.Now(),
			},
			wantErr: false,
		},
		{
			name: "missing id",
			ws: Workspace{
				Name:      "Dev Workspace",
				SyncState: "local",
			},
			wantErr: true,
		},
		{
			name: "missing name",
			ws: Workspace{
				ID:        "ws-1",
				SyncState: "local",
			},
			wantErr: true,
		},
		{
			name: "invalid sync state",
			ws: Workspace{
				ID:        "ws-1",
				Name:      "Dev Workspace",
				SyncState: "invalid",
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.ws.Validate(); (err != nil) != tt.wantErr {
				t.Errorf("Workspace.Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestSavedQuery_Validate(t *testing.T) {
	tests := []struct {
		name    string
		sq      SavedQuery
		wantErr bool
	}{
		{
			name: "valid saved query",
			sq: SavedQuery{
				ID:          "q-1",
				WorkspaceID: "ws-1",
				ProfileID:   "prof-1",
				Name:        "Get Users",
				QueryText:   "SELECT * FROM users",
				SyncState:   "local",
			},
			wantErr: false,
		},
		{
			name: "missing profile id",
			sq: SavedQuery{
				ID:          "q-1",
				WorkspaceID: "ws-1",
				Name:        "Get Users",
				QueryText:   "SELECT * FROM users",
				SyncState:   "local",
			},
			wantErr: true,
		},
		{
			name: "missing query text",
			sq: SavedQuery{
				ID:          "q-1",
				WorkspaceID: "ws-1",
				ProfileID:   "prof-1",
				Name:        "Get Users",
				SyncState:   "local",
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.sq.Validate(); (err != nil) != tt.wantErr {
				t.Errorf("SavedQuery.Validate() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
