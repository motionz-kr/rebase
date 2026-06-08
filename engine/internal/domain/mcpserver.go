package domain

import (
	"encoding/json"
	"strings"
	"time"
)

// McpServer is one external stdio MCP server configured for a workspace. Args
// is a JSON array string; env (secrets) lives in the keychain, not here.
type McpServer struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspaceId"`
	Name        string    `json:"name"`
	Command     string    `json:"command"`
	Args        string    `json:"args"` // JSON array
	Enabled     bool      `json:"enabled"`
	Trusted     bool      `json:"trusted"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// ArgsList parses Args JSON into a slice. Invalid/empty yields nil.
func (s McpServer) ArgsList() []string {
	if strings.TrimSpace(s.Args) == "" {
		return nil
	}
	var out []string
	_ = json.Unmarshal([]byte(s.Args), &out)
	return out
}
