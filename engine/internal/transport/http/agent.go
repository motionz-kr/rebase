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
	"github.com/smlee/database-local-engine/engine/internal/adapters/mcpclient"
	"github.com/smlee/database-local-engine/engine/internal/adapters/mongo"
	"github.com/smlee/database-local-engine/engine/internal/adapters/mysql"
	"github.com/smlee/database-local-engine/engine/internal/adapters/postgres"
	"github.com/smlee/database-local-engine/engine/internal/adapters/redis"
	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlite"
	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlserver"
	"github.com/smlee/database-local-engine/engine/internal/agent"
	"github.com/smlee/database-local-engine/engine/internal/application"
	"github.com/smlee/database-local-engine/engine/internal/domain"
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
	redisConnector     *redis.RedisConnector
	mongoConnector     *mongo.MongoConnector

	oauthMu      sync.Mutex
	pendingOAuth map[string]llm.PKCEParams // provider -> in-flight PKCE attempt

	mcpRepo *sqlite.SQLiteMcpServerRepository
	secrets ports.SecretStore
}

func NewAgentHandler(token string, service *application.ConnectionService) *AgentHandler {
	return &AgentHandler{
		token:              token,
		service:            service,
		mysqlConnector:     mysql.NewMySQLConnector(),
		postgresConnector:  postgres.NewPostgreSQLConnector(),
		sqliteConnector:    sqlite.NewSQLiteConnector(),
		sqlserverConnector: sqlserver.NewSQLServerConnector(),
		redisConnector:     redis.NewRedisConnector(),
		mongoConnector:     mongo.NewMongoConnector(),
		pendingOAuth:       make(map[string]llm.PKCEParams),
	}
}

// SetMCP wires the external-MCP-server registry + secret store so the agent run
// can attach external tools. Optional — if unset, no external tools are added.
func (h *AgentHandler) SetMCP(repo *sqlite.SQLiteMcpServerRepository, secrets ports.SecretStore) {
	h.mcpRepo = repo
	h.secrets = secrets
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

// providerParams carries the fields needed to construct an LLM provider.
type providerParams struct {
	ProfileID string
	Provider  string
	APIKey    string
	Model     string
}

// buildProvider resolves an LLMProvider from request params, reusing the agent's
// credential rules (explicit key → keychain; OAuth via keychain). The returned
// cleanup func removes any temp MCP config (cli provider); callers must defer it.
// Shared by Run() and Complete().
func (h *AgentHandler) buildProvider(ctx context.Context, p providerParams) (ports.LLMProvider, func(), error) {
	cleanup := func() {}
	apiKey := p.APIKey
	if apiKey == "" && (p.Provider == "anthropic" || p.Provider == "openai") {
		if k, kerr := h.service.GetAgentKey(ctx, p.Provider); kerr == nil {
			apiKey = k
		}
	}
	switch p.Provider {
	case "anthropic":
		return llm.NewAnthropicProvider(apiKey, p.Model, ""), cleanup, nil
	case "anthropic-oauth":
		return llm.NewAnthropicOAuthProvider(oauthTokenStore{service: h.service, provider: "anthropic"}, p.Model, ""), cleanup, nil
	case "openai-oauth":
		return llm.NewCodexOAuthProvider(oauthTokenStore{service: h.service, provider: "openai"}, p.Model), cleanup, nil
	case "openai":
		return llm.NewOpenAIProvider(apiKey, p.Model, ""), cleanup, nil
	case "cli":
		exe, err := os.Executable()
		if err != nil {
			return nil, cleanup, err
		}
		tmp, err := os.CreateTemp("", "rebase-mcp-*.json")
		if err != nil {
			return nil, cleanup, err
		}
		_, _ = tmp.WriteString(buildMCPConfig(exe, p.ProfileID))
		_ = tmp.Close()
		name := tmp.Name()
		return llm.NewCliProvider(name, "default", os.Environ()), func() { os.Remove(name) }, nil
	case "codex":
		exe, err := os.Executable()
		if err != nil {
			return nil, cleanup, err
		}
		return llm.NewCodexProvider(exe, p.ProfileID, p.Model, os.Environ()), cleanup, nil
	default:
		return llm.NewStubProvider(), cleanup, nil
	}
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
		provider, cleanup, perr := h.buildProvider(r.Context(), providerParams{
			ProfileID: body.ProfileID, Provider: body.Provider, APIKey: body.APIKey, Model: body.Model,
		})
		if perr != nil {
			http.Error(w, perr.Error(), http.StatusInternalServerError)
			return
		}
		defer cleanup()

		var registry *agent.Registry
		switch profile.Driver {
		case "redis":
			registry = agent.NewRedisRegistry(h.redisConnector, *profile, password)
		case "mongodb":
			registry = agent.NewMongoRegistry(h.mongoConnector, *profile, password, profile.Database)
		default:
			conn, cerr := h.getConnector(profile.Driver)
			if cerr != nil {
				http.Error(w, cerr.Error(), http.StatusBadRequest)
				return
			}
			registry = agent.NewSQLRegistry(conn, *profile, password, profile.Database)
		}
		svc := agent.NewAgentService(provider, registry, 16)
		svc.SetPolicy(agent.Policy{DataExposure: body.DataExposure})
		// Never let the connection password / secret ref reach the provider.
		svc.SetSecrets([]string{password, profile.SecretRef})
		// Only surface tenant columns to the domain block when they were
		// explicitly configured for this connection. Otherwise a bare
		// connection (no glossary/notes/soft-delete) would still get a
		// non-empty domain context from TenantColumnList()'s defaults,
		// changing the agent's behavior — the design guarantees byte-identical
		// behavior when no domain dictionary is set.
		var tenantCols []string
		if strings.TrimSpace(profile.TenantColumns) != "" {
			tenantCols = profile.TenantColumnList()
		}
		svc.SetDomainContext(agent.BuildDomainContext(
			profile.DomainGlossaryEntries(),
			profile.DomainNotes,
			tenantCols,
			profile.DomainBindingMap()["soft_delete"],
		))

		if h.mcpRepo != nil {
			servers, _ := h.mcpRepo.List(r.Context(), "default")
			dial := func(ctx context.Context, s domain.McpServer) (agent.McpCaller, error) {
				if s.TransportKind() == "http" {
					headers := map[string]string{}
					if h.secrets != nil {
						if blob, e := h.secrets.Get(ctx, "mcp_headers_"+s.ID); e == nil && blob != "" {
							_ = json.Unmarshal([]byte(blob), &headers)
						}
					}
					c, err := mcpclient.DialHTTP(ctx, s.URL, headers)
					if err != nil {
						return nil, err
					}
					return c, nil
				}
				env := map[string]string{}
				if h.secrets != nil {
					if blob, e := h.secrets.Get(ctx, "mcp_env_"+s.ID); e == nil && blob != "" {
						_ = json.Unmarshal([]byte(blob), &env)
					}
				}
				c, err := mcpclient.DialStdio(ctx, s.Command, s.ArgsList(), env)
				if err != nil {
					return nil, err
				}
				return c, nil
			}
			detach, _ := agent.AttachMCPServers(r.Context(), registry, servers, dial)
			defer detach()
		}

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

// Complete streams a single tool-free LLM completion as NDJSON (one
// ports.LLMEvent per line). Unlike Run(), it attaches NO DB tools, so the model
// answers purely from the provided messages (result → work-sentence narration).
// Body: {profileId?, messages, system, provider, apiKey, model}.
func (h *AgentHandler) Complete() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID string             `json:"profileId"`
			Messages  []ports.LLMMessage `json:"messages"`
			System    string             `json:"system"`
			Provider  string             `json:"provider"`
			APIKey    string             `json:"apiKey"`
			Model     string             `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if len(body.Messages) == 0 {
			http.Error(w, "a non-empty messages array is required", http.StatusBadRequest)
			return
		}
		provider, cleanup, perr := h.buildProvider(r.Context(), providerParams{
			ProfileID: body.ProfileID, Provider: body.Provider, APIKey: body.APIKey, Model: body.Model,
		})
		if perr != nil {
			http.Error(w, perr.Error(), http.StatusInternalServerError)
			return
		}
		defer cleanup()

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
		req := ports.LLMRequest{System: body.System, Messages: body.Messages, Tools: nil, Model: body.Model}
		if err := provider.Complete(r.Context(), req, emit); err != nil {
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
