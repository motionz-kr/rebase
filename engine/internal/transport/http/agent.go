package http

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/adapters/llm"
	"github.com/smlee/database-local-engine/engine/internal/adapters/mysql"
	"github.com/smlee/database-local-engine/engine/internal/adapters/postgres"
	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlite"
	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlserver"
	"github.com/smlee/database-local-engine/engine/internal/agent"
	"github.com/smlee/database-local-engine/engine/internal/application"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// oauthTokenStore adapts the keychain-backed ConnectionService to the
// llm.OAuthTokenStore interface (JSON blob <-> OAuthToken). Background context
// is fine: keychain reads/writes are local and fast.
type oauthTokenStore struct {
	service  *application.ConnectionService
	provider string
}

func (s oauthTokenStore) Get() (llm.OAuthToken, error) {
	blob, err := s.service.GetOAuthToken(context.Background(), s.provider)
	if err != nil || blob == "" {
		return llm.OAuthToken{}, err
	}
	var t llm.OAuthToken
	if jerr := json.Unmarshal([]byte(blob), &t); jerr != nil {
		return llm.OAuthToken{}, jerr
	}
	return t, nil
}

func (s oauthTokenStore) Set(t llm.OAuthToken) error {
	b, err := json.Marshal(t)
	if err != nil {
		return err
	}
	return s.service.SetOAuthToken(context.Background(), s.provider, string(b))
}

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
	token              string
	service            *application.ConnectionService
	mysqlConnector     *mysql.MySQLConnector
	postgresConnector  *postgres.PostgreSQLConnector
	sqliteConnector    *sqlite.SQLiteConnector
	sqlserverConnector *sqlserver.SQLServerConnector

	oauthMu      sync.Mutex
	pendingOAuth map[string]llm.PKCEParams // provider -> in-flight PKCE attempt
}

func NewAgentHandler(token string, service *application.ConnectionService) *AgentHandler {
	return &AgentHandler{
		token:              token,
		service:            service,
		mysqlConnector:     mysql.NewMySQLConnector(),
		postgresConnector:  postgres.NewPostgreSQLConnector(),
		sqliteConnector:    sqlite.NewSQLiteConnector(),
		sqlserverConnector: sqlserver.NewSQLServerConnector(),
		pendingOAuth:       make(map[string]llm.PKCEParams),
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
	case "sqlite":
		return h.sqliteConnector, nil
	case "sqlserver":
		return h.sqlserverConnector, nil
	default:
		return nil, fmtError("agent mode currently supports SQL drivers (mysql, postgres, sqlite, sqlserver); got: " + driver)
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
		case "anthropic-oauth":
			provider = llm.NewAnthropicOAuthProvider(oauthTokenStore{service: h.service, provider: "anthropic"}, body.Model, "")
		case "openai-oauth":
			provider = llm.NewCodexOAuthProvider(oauthTokenStore{service: h.service, provider: "openai"}, body.Model)
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

// OAuth drives subscription OAuth login (browser → paste-code) for providers
// like Claude. Tokens are stored in the keychain; the renderer never sees them.
//
//	POST   /agent/oauth/start    {provider}        -> {authorizeUrl}
//	POST   /agent/oauth/complete {provider, code}  -> {ok}      (exchange + store)
//	GET    /agent/oauth/status?provider=           -> {loggedIn, expiresAt}
//	DELETE /agent/oauth/status?provider=           -> clears tokens
func (h *AgentHandler) OAuth() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch strings.TrimPrefix(r.URL.Path, "/agent/oauth/") {
		case "start":
			var b struct {
				Provider string `json:"provider"`
			}
			_ = json.NewDecoder(r.Body).Decode(&b)
			switch b.Provider {
			case "anthropic":
				// Paste-code flow: the user copies the code back into the app.
				params, err := llm.NewAnthropicPKCE()
				if err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				h.oauthMu.Lock()
				h.pendingOAuth[b.Provider] = params
				h.oauthMu.Unlock()
				_ = json.NewEncoder(w).Encode(map[string]string{"authorizeUrl": params.AuthorizeURL})
			case "openai":
				// Loopback flow: OpenAI redirects to localhost:1455, which the
				// engine catches, exchanges, and stores — no paste step.
				login, err := llm.NewCodexLogin()
				if err != nil {
					http.Error(w, err.Error(), http.StatusInternalServerError)
					return
				}
				go func() {
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
					defer cancel()
					_ = llm.RunCodexLoopback(ctx, login, func(tok llm.OAuthToken) error {
						blob, _ := json.Marshal(tok)
						return h.service.SetOAuthToken(context.Background(), "openai", string(blob))
					})
				}()
				_ = json.NewEncoder(w).Encode(map[string]string{"authorizeUrl": login.AuthorizeURL})
			default:
				http.Error(w, "unsupported oauth provider: "+b.Provider, http.StatusBadRequest)
			}
		case "complete":
			var b struct {
				Provider string `json:"provider"`
				Code     string `json:"code"`
			}
			if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
				http.Error(w, "invalid request body", http.StatusBadRequest)
				return
			}
			h.oauthMu.Lock()
			params, ok := h.pendingOAuth[b.Provider]
			h.oauthMu.Unlock()
			if !ok {
				http.Error(w, "no pending login for "+b.Provider+"; start again", http.StatusBadRequest)
				return
			}
			tok, err := llm.ExchangeAnthropicCode(r.Context(), nil, b.Code, params.Verifier)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadGateway)
				return
			}
			blob, _ := json.Marshal(tok)
			if err := h.service.SetOAuthToken(r.Context(), b.Provider, string(blob)); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			h.oauthMu.Lock()
			delete(h.pendingOAuth, b.Provider)
			h.oauthMu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		case "status":
			provider := r.URL.Query().Get("provider")
			if r.Method == http.MethodDelete {
				_ = h.service.ClearOAuthToken(r.Context(), provider)
				_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
				return
			}
			resp := map[string]any{"loggedIn": false}
			if blob, err := h.service.GetOAuthToken(r.Context(), provider); err == nil && blob != "" {
				var t llm.OAuthToken
				if json.Unmarshal([]byte(blob), &t) == nil && t.AccessToken != "" {
					resp["loggedIn"] = true
					resp["expiresAt"] = t.ExpiresAt
				}
			}
			_ = json.NewEncoder(w).Encode(resp)
		default:
			http.Error(w, "not found", http.StatusNotFound)
		}
	})
}
