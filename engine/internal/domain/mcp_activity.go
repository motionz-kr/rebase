package domain

import (
	"strings"
	"time"
)

// MCPActivityEvent is a safe, non-secret audit record for MCP lifecycle and
// tool activity. Raw SQL and credentials are deliberately not stored here.
type MCPActivityEvent struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspaceId"`
	ProfileID   string    `json:"profileId"`
	ServerID    string    `json:"serverId"`
	Direction   string    `json:"direction"` // inbound | outbound
	Event       string    `json:"event"`     // session_started | session_ended | test | connect | tool_call
	Tool        string    `json:"tool"`
	Status      string    `json:"status"` // success | error
	Error       string    `json:"error,omitempty"`
	DurationMs  int64     `json:"durationMs"`
	CreatedAt   time.Time `json:"createdAt"`
}

type MCPActivityFilter struct {
	WorkspaceID string
	ProfileID   string
	ServerID    string
	Limit       int
}

// SafeMCPError removes query/auth details before an error is persisted in the
// local activity history. The full error may still be returned to the caller;
// this boundary is specifically for durable audit metadata.
func SafeMCPError(message string) string {
	message = strings.Join(strings.Fields(strings.TrimSpace(message)), " ")
	if message == "" {
		return ""
	}
	lower := strings.ToLower(message)
	for _, marker := range []string{
		"select ", "insert ", "update ", "delete ", "alter ", "create ", "drop ", "truncate ",
		" from ", " join ", " where ", "password", "authorization", "bearer ", " token",
	} {
		if strings.Contains(lower, marker) {
			return "operation failed; sensitive details omitted"
		}
	}
	if len(message) > 240 {
		return message[:240] + "…"
	}
	return message
}
