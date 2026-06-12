package http

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/adapters/mcpclient"
	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlite"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// newID generates a random 16-byte hex string for use as a server id.
func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

type McpServerHandler struct {
	token   string
	repo    *sqlite.SQLiteMcpServerRepository
	secrets ports.SecretStore
}

func NewMcpServerHandler(token string, repo *sqlite.SQLiteMcpServerRepository, secrets ports.SecretStore) *McpServerHandler {
	return &McpServerHandler{token: token, repo: repo, secrets: secrets}
}

func (h *McpServerHandler) checkToken(r *http.Request) bool {
	return validToken(r.Header.Get("X-App-Engine-Token"), h.token)
}

// envFor retrieves the stored env map for a server from the secret store.
func (h *McpServerHandler) envFor(ctx context.Context, serverID string) map[string]string {
	env := map[string]string{}
	if blob, err := h.secrets.Get(ctx, "mcp_env_"+serverID); err == nil && blob != "" {
		_ = json.Unmarshal([]byte(blob), &env)
	}
	return env
}

// headersFor retrieves stored auth headers for a server from the keychain.
func (h *McpServerHandler) headersFor(ctx context.Context, serverID string) map[string]string {
	out := map[string]string{}
	if blob, err := h.secrets.Get(ctx, "mcp_headers_"+serverID); err == nil && blob != "" {
		_ = json.Unmarshal([]byte(blob), &out)
	}
	return out
}

// dialServer opens a client for a stored server, branching on transport.
func (h *McpServerHandler) dialServer(ctx context.Context, s domain.McpServer) (*mcpclient.Client, error) {
	if s.TransportKind() == "http" {
		return mcpclient.DialHTTP(ctx, s.URL, h.headersFor(ctx, s.ID))
	}
	return mcpclient.DialStdio(ctx, s.Command, s.ArgsList(), h.envFor(ctx, s.ID))
}

// mcpServerDTO is the response shape — args as []string, not a JSON string.
type mcpServerDTO struct {
	ID          string   `json:"id"`
	WorkspaceID string   `json:"workspaceId"`
	Name        string   `json:"name"`
	Command     string   `json:"command"`
	Args        []string `json:"args"`
	Enabled     bool     `json:"enabled"`
	Trusted     bool     `json:"trusted"`
	Transport   string   `json:"transport"`
	URL         string   `json:"url"`
}

func toDTO(s domain.McpServer) mcpServerDTO {
	args := s.ArgsList()
	if args == nil {
		args = []string{}
	}
	return mcpServerDTO{
		ID:          s.ID,
		WorkspaceID: s.WorkspaceID,
		Name:        s.Name,
		Command:     s.Command,
		Args:        args,
		Enabled:     s.Enabled,
		Trusted:     s.Trusted,
		Transport:   s.Transport,
		URL:         s.URL,
	}
}

// Servers handles GET/POST/DELETE /mcp/servers.
func (h *McpServerHandler) Servers() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")

		switch r.Method {
		case http.MethodGet:
			wsID := r.URL.Query().Get("workspaceId")
			if wsID == "" {
				wsID = "default"
			}
			servers, err := h.repo.List(r.Context(), wsID)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			dtos := make([]mcpServerDTO, len(servers))
			for i, s := range servers {
				dtos[i] = toDTO(s)
			}
			_ = json.NewEncoder(w).Encode(dtos)

		case http.MethodPost:
			var body struct {
				ID        string             `json:"id"`
				Name      string             `json:"name"`
				Command   string             `json:"command"`
				Args      []string           `json:"args"`
				Enabled   bool               `json:"enabled"`
				Trusted   bool               `json:"trusted"`
				Transport string             `json:"transport"`
				URL       string             `json:"url"`
				Env       *map[string]string `json:"env"`
				Headers   *map[string]string `json:"headers"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, "invalid request body", http.StatusBadRequest)
				return
			}

			// Marshal args slice back to a JSON string for storage.
			argsJSON, _ := json.Marshal(body.Args)

			now := time.Now()
			id := body.ID
			isUpdate := false

			if id != "" {
				// Check if the server exists.
				existing, _ := h.repo.List(r.Context(), "default")
				for _, s := range existing {
					if s.ID == id {
						isUpdate = true
						break
					}
				}
			} else {
				id = newID()
			}

			s := domain.McpServer{
				ID:          id,
				WorkspaceID: "default",
				Name:        body.Name,
				Command:     body.Command,
				Args:        string(argsJSON),
				Enabled:     body.Enabled,
				Trusted:     body.Trusted,
				Transport:   body.Transport,
				URL:         body.URL,
				CreatedAt:   now,
				UpdatedAt:   now,
			}

			var opErr error
			if isUpdate {
				opErr = h.repo.Update(r.Context(), &s)
			} else {
				opErr = h.repo.Create(r.Context(), &s)
			}
			if opErr != nil {
				http.Error(w, opErr.Error(), http.StatusInternalServerError)
				return
			}

			// Only touch the keychain when env is present in the request. A nil pointer
			// (field omitted) leaves existing env unchanged; an explicit {} clears it.
			if body.Env != nil {
				envBlob, _ := json.Marshal(*body.Env)
				_ = h.secrets.Set(r.Context(), "mcp_env_"+id, string(envBlob))
			}
			if body.Headers != nil {
				hb, _ := json.Marshal(*body.Headers)
				_ = h.secrets.Set(r.Context(), "mcp_headers_"+id, string(hb))
			}

			_ = json.NewEncoder(w).Encode(map[string]string{"id": id})

		case http.MethodDelete:
			id := r.URL.Query().Get("id")
			if id == "" {
				http.Error(w, "id parameter is required", http.StatusBadRequest)
				return
			}
			if err := h.repo.Delete(r.Context(), id); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			_ = h.secrets.Delete(r.Context(), "mcp_env_"+id)
			_ = h.secrets.Delete(r.Context(), "mcp_headers_"+id)
			_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})

		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

// Test handles POST /mcp/servers/test — dials and lists tools.
func (h *McpServerHandler) Test() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")

		var body struct {
			Transport string            `json:"transport"`
			URL       string            `json:"url"`
			Command   string            `json:"command"`
			Args      []string          `json:"args"`
			Env       map[string]string `json:"env"`
			Headers   map[string]string `json:"headers"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()

		var client *mcpclient.Client
		var derr error
		if body.Transport == "http" {
			client, derr = mcpclient.DialHTTP(ctx, body.URL, body.Headers)
		} else {
			client, derr = mcpclient.DialStdio(ctx, body.Command, body.Args, body.Env)
		}
		if derr != nil {
			_ = json.NewEncoder(w).Encode(map[string]string{"error": derr.Error()})
			return
		}
		defer client.Close()

		tools, err := client.ListTools(ctx)
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}

		type toolInfo struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		}
		result := make([]toolInfo, len(tools))
		for i, t := range tools {
			result[i] = toolInfo{Name: t.Name, Description: t.Description}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"tools": result})
	})
}

// Call handles POST /mcp/servers/call — dials a configured server and calls a tool.
func (h *McpServerHandler) Call() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")

		var body struct {
			ServerID string         `json:"serverId"`
			Tool     string         `json:"tool"`
			ToolArgs map[string]any `json:"toolArgs"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}

		// Find the server config by id.
		servers, err := h.repo.List(r.Context(), "default")
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		var found *domain.McpServer
		for i := range servers {
			if servers[i].ID == body.ServerID {
				found = &servers[i]
				break
			}
		}
		if found == nil {
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "server not found: " + body.ServerID})
			return
		}

		client, err := h.dialServer(r.Context(), *found)
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		defer client.Close()

		result, err := client.Call(r.Context(), body.Tool, body.ToolArgs)
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"result": result})
	})
}
