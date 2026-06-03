package http

import (
	"encoding/json"
	"net/http"
	"os"

	"github.com/smlee/database-local-engine/engine/internal/adapters/llm"
	"github.com/smlee/database-local-engine/engine/internal/adapters/mysql"
	"github.com/smlee/database-local-engine/engine/internal/adapters/postgres"
	"github.com/smlee/database-local-engine/engine/internal/agent"
	"github.com/smlee/database-local-engine/engine/internal/application"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// buildMCPConfig returns a claude --mcp-config JSON that launches this same
// engine binary in -mcp mode as the "rebase" tool server for the profile.
func buildMCPConfig(exePath, profileID string) string {
	cfg := map[string]any{
		"mcpServers": map[string]any{
			"rebase": map[string]any{
				"command": exePath,
				"args":    []string{"-mcp", profileID, "-token", "mcp", "-handshake", os.DevNull},
			},
		},
	}
	b, _ := json.Marshal(cfg)
	return string(b)
}

type AgentHandler struct {
	token             string
	service           *application.ConnectionService
	mysqlConnector    *mysql.MySQLConnector
	postgresConnector *postgres.PostgreSQLConnector
}

func NewAgentHandler(token string, service *application.ConnectionService) *AgentHandler {
	return &AgentHandler{
		token:             token,
		service:           service,
		mysqlConnector:    mysql.NewMySQLConnector(),
		postgresConnector: postgres.NewPostgreSQLConnector(),
	}
}

func (h *AgentHandler) checkToken(r *http.Request) bool {
	return validToken(r.Header.Get("X-App-Engine-Token"), h.token)
}

func (h *AgentHandler) getConnector(driver string) (ports.SQLConnector, error) {
	switch driver {
	case "mysql":
		return h.mysqlConnector, nil
	case "postgres":
		return h.postgresConnector, nil
	default:
		return nil, fmtError("agent mode currently supports SQL drivers (mysql, postgres); got: " + driver)
	}
}

// SetMCPConnection toggles per-connection MCP exposure + data-exposure.
// POST /mcp/connection {profileId, enabled, dataExposure}
func (h *AgentHandler) SetMCPConnection() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var b struct {
			ProfileID    string `json:"profileId"`
			Enabled      bool   `json:"enabled"`
			DataExposure string `json:"dataExposure"`
		}
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if err := h.service.SetMCPConnectionSettings(r.Context(), b.ProfileID, b.Enabled, b.DataExposure); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})
}

// Key manages stored agent API keys in the OS keychain (issue #10) so the
// renderer never persists a raw key.
//   - GET    /agent/key?provider=anthropic  -> {"present": bool}
//   - POST   /agent/key  {provider, key}     -> store (empty key clears)
//   - DELETE /agent/key?provider=anthropic   -> clear
func (h *AgentHandler) Key() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodGet:
			provider := r.URL.Query().Get("provider")
			_ = json.NewEncoder(w).Encode(map[string]bool{"present": h.service.HasAgentKey(r.Context(), provider)})
		case http.MethodPost:
			var b struct {
				Provider string `json:"provider"`
				Key      string `json:"key"`
			}
			if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
				http.Error(w, "invalid request body", http.StatusBadRequest)
				return
			}
			// An empty key means "forget it" rather than storing a blank secret.
			var err error
			if b.Key == "" {
				err = h.service.ClearAgentKey(r.Context(), b.Provider)
			} else {
				err = h.service.SetAgentKey(r.Context(), b.Provider, b.Key)
			}
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		case http.MethodDelete:
			_ = h.service.ClearAgentKey(r.Context(), r.URL.Query().Get("provider"))
			_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}

// Run streams an agent turn as NDJSON (one ports.LLMEvent per line).
// Body: {profileId, messages:[{role,text}], provider:"stub"|"anthropic", apiKey, model}.
func (h *AgentHandler) Run() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID    string             `json:"profileId"`
			Messages     []ports.LLMMessage `json:"messages"`
			Provider     string             `json:"provider"`
			APIKey       string             `json:"apiKey"`
			Model        string             `json:"model"`
			DataExposure string             `json:"dataExposure"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if body.ProfileID == "" || len(body.Messages) == 0 {
			http.Error(w, "profileId and a non-empty messages array are required", http.StatusBadRequest)
			return
		}

		profile, password, err := h.service.GetProfile(r.Context(), body.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		conn, err := h.getConnector(profile.Driver)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		// Resolve the API key: prefer an explicit per-request key, else fall back
		// to the one stored in the OS keychain (issue #10: "key in keychain").
		apiKey := body.APIKey
		if apiKey == "" && (body.Provider == "anthropic" || body.Provider == "openai") {
			if k, kerr := h.service.GetAgentKey(r.Context(), body.Provider); kerr == nil {
				apiKey = k
			}
		}

		var provider ports.LLMProvider
		switch body.Provider {
		case "anthropic":
			provider = llm.NewAnthropicProvider(apiKey, body.Model, "")
		case "openai":
			provider = llm.NewOpenAIProvider(apiKey, body.Model, "")
		case "cli":
			exe, err := os.Executable()
			if err != nil {
				http.Error(w, "cannot locate engine binary for MCP: "+err.Error(), http.StatusInternalServerError)
				return
			}
			tmp, err := os.CreateTemp("", "rebase-mcp-*.json")
			if err != nil {
				http.Error(w, "cannot write MCP config: "+err.Error(), http.StatusInternalServerError)
				return
			}
			_, _ = tmp.WriteString(buildMCPConfig(exe, body.ProfileID))
			_ = tmp.Close()
			defer os.Remove(tmp.Name())
			provider = llm.NewCliProvider(tmp.Name(), "default", os.Environ())
		case "codex":
			exe, err := os.Executable()
			if err != nil {
				http.Error(w, "cannot locate engine binary for MCP: "+err.Error(), http.StatusInternalServerError)
				return
			}
			provider = llm.NewCodexProvider(exe, body.ProfileID, body.Model, os.Environ())
		default:
			provider = llm.NewStubProvider()
		}

		registry := agent.NewSQLRegistry(conn, *profile, password, profile.Database)
		svc := agent.NewAgentService(provider, registry, 16)
		svc.SetPolicy(agent.Policy{DataExposure: body.DataExposure})
		// Never let the connection password / secret ref reach the provider.
		svc.SetSecrets([]string{password, profile.SecretRef})

		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, _ := w.(http.Flusher)
		enc := json.NewEncoder(w)

		emit := func(e ports.LLMEvent) {
			_ = enc.Encode(e)
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err := svc.Run(r.Context(), body.Messages, emit); err != nil {
			emit(ports.LLMEvent{Kind: ports.EventError, Err: err.Error()})
		}
	})
}
