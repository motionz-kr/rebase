package http

import (
	"encoding/json"
	"net/http"

	"github.com/smlee/database-local-engine/engine/internal/adapters/llm"
	"github.com/smlee/database-local-engine/engine/internal/adapters/mysql"
	"github.com/smlee/database-local-engine/engine/internal/adapters/postgres"
	"github.com/smlee/database-local-engine/engine/internal/agent"
	"github.com/smlee/database-local-engine/engine/internal/application"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

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

// Run streams an agent turn as NDJSON (one ports.LLMEvent per line).
// Body: {profileId, messages:[{role,text}], provider:"stub"|"anthropic", apiKey, model}.
func (h *AgentHandler) Run() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID string             `json:"profileId"`
			Messages  []ports.LLMMessage `json:"messages"`
			Provider  string             `json:"provider"`
			APIKey    string             `json:"apiKey"`
			Model     string             `json:"model"`
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

		var provider ports.LLMProvider
		switch body.Provider {
		case "anthropic":
			provider = llm.NewAnthropicProvider(body.APIKey, body.Model, "")
		default:
			provider = llm.NewStubProvider()
		}

		registry := agent.NewSQLRegistry(conn, *profile, password, profile.Database)
		svc := agent.NewAgentService(provider, registry, 16)

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
