package http

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/adapters/mysql"
	"github.com/smlee/database-local-engine/engine/internal/adapters/postgres"
	"github.com/smlee/database-local-engine/engine/internal/application"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type QueryHandler struct {
	token             string
	service           *application.ConnectionService
	mysqlConnector    *mysql.MySQLConnector
	postgresConnector *postgres.PostgreSQLConnector
}

func NewQueryHandler(token string, service *application.ConnectionService) *QueryHandler {
	return &QueryHandler{
		token:             token,
		service:           service,
		mysqlConnector:    mysql.NewMySQLConnector(),
		postgresConnector: postgres.NewPostgreSQLConnector(),
	}
}

func (h *QueryHandler) getConnector(driver string) (ports.SQLConnector, error) {
	switch driver {
	case "mysql":
		return h.mysqlConnector, nil
	case "postgres":
		return h.postgresConnector, nil
	default:
		return nil, fmtError("unsupported SQL driver for query: " + driver)
	}
}

func (h *QueryHandler) checkToken(r *http.Request) bool {
	reqToken := r.Header.Get("X-App-Engine-Token")
	return validToken(reqToken, h.token)
}

type ExecuteQueryRequest struct {
	ProfileID string `json:"profileId"`
	Query     string `json:"query"`
	QueryID   string `json:"queryId"`
	// AllowWrite must be set for any statement that is not confidently
	// read-only; otherwise the engine refuses it (read-only by default).
	AllowWrite bool `json:"allowWrite"`
	// ConfirmDestructive must be set to run a destructive statement
	// (DROP/TRUNCATE/ALTER/GRANT, unqualified DELETE/UPDATE, etc.).
	ConfirmDestructive bool `json:"confirmDestructive"`
	// MaxRows overrides the default streamed-row cap (0 = default).
	MaxRows int `json:"maxRows"`
	// FetchAll disables the row cap entirely (opt-in large fetch, ADR-0004).
	FetchAll bool `json:"fetchAll"`
}

// defaultRowLimit caps how many rows a query streams to the renderer unless the
// caller opts into a larger fetch (ADR-0004). Streaming keeps the engine's
// memory bounded, but the renderer still accumulates rows, so we cap by default.
const defaultRowLimit = 1000

// errRowLimitReached is an internal sentinel used to stop streaming once the
// row cap is hit. It is treated as a successful (truncated) result, not a error.
var errRowLimitReached = fmtError("row limit reached")

// writeQueryPolicyError emits a structured JSON error the renderer can act on
// (e.g. prompt for write/destructive confirmation) before any stream starts.
func writeQueryPolicyError(w http.ResponseWriter, status int, code, message, verb string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]any{
		"error": message,
		"code":  code,
		"verb":  verb,
	})
}

type ExecuteBatchRequest struct {
	ProfileID          string   `json:"profileId"`
	Statements         []string `json:"statements"`
	AllowWrite         bool     `json:"allowWrite"`
	ConfirmDestructive bool     `json:"confirmDestructive"`
}

type CancelQueryRequest struct {
	QueryID string `json:"queryId"`
}

func (h *QueryHandler) ExecuteQuery() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		var req ExecuteQueryRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.ProfileID == "" || req.Query == "" || req.QueryID == "" {
			http.Error(w, "profileId, query, and queryId are required", http.StatusBadRequest)
			return
		}

		// Advisory policy gate (security.md): read-only by default, destructive
		// statements require explicit confirmation. This runs before the stream
		// starts so we can still return a real HTTP status + structured error.
		class := domain.ClassifyQuery(req.Query)
		if !class.ReadOnly && !req.AllowWrite {
			writeQueryPolicyError(w, http.StatusForbidden, "read_only_blocked",
				"This statement may modify data and is blocked in read-only mode. Enable write mode to run it.", class.Verb)
			return
		}
		if class.Destructive && !req.ConfirmDestructive {
			writeQueryPolicyError(w, http.StatusConflict, "confirmation_required",
				"This is a destructive statement. Confirm to run it.", class.Verb)
			return
		}

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
			return
		}

		profile, password, err := h.service.GetProfile(r.Context(), req.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		connector, err := h.getConnector(profile.Driver)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("Transfer-Encoding", "chunked")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		// Derive from the request context so a client disconnect (renderer
		// closes the stream / window) also cancels the running query instead
		// of letting it run to completion against a dead socket.
		queryCtx, queryCancel := context.WithCancel(r.Context())
		defer queryCancel()

		// Guarantee the cancellation registry entry is removed even if the
		// connector panics or returns early, preventing a stale-entry leak.
		defer h.service.CancelRegistry.Unregister(req.QueryID)

		// Register session start
		onSessionStart := func(sessionID int64) {
			h.service.CancelRegistry.Register(req.QueryID, &application.CancelInfo{
				SessionID: sessionID,
				ProfileID: req.ProfileID,
				Driver:    profile.Driver,
				CancelFn:  queryCancel,
			})
		}

		// Row metadata header callback
		onHeader := func(columns []string) error {
			meta := map[string]any{
				"type":    "meta",
				"columns": columns,
			}
			data, _ := json.Marshal(meta)
			_, err := fmt.Fprintf(w, "%s\n", data)
			flusher.Flush()
			return err
		}

		// Resolve the row cap: default unless the caller opts into a larger or
		// unlimited fetch.
		limit := defaultRowLimit
		if req.MaxRows > 0 {
			limit = req.MaxRows
		}
		if req.FetchAll {
			limit = 0 // unlimited
		}

		streamed := 0
		truncated := false

		// Individual row streaming callback
		onRow := func(row []any) error {
			if limit > 0 && streamed >= limit {
				truncated = true
				return errRowLimitReached // stop the connector early
			}
			rowMsg := map[string]any{
				"type": "row",
				"data": row,
			}
			data, _ := json.Marshal(rowMsg)
			_, err := fmt.Fprintf(w, "%s\n", data)
			flusher.Flush()
			streamed++
			return err
		}

		// Read-only by default: forces a read-only DB session unless the caller
		// explicitly enabled writes (defense-in-depth on top of the classifier).
		readOnly := !req.AllowWrite

		// Execute stream
		rowsAffected, executeErr := connector.ExecuteQueryStream(queryCtx, *profile, password, req.Query, readOnly, onSessionStart, onHeader, onRow)

		// Hitting the row cap is a successful, truncated result — not an error.
		if executeErr != nil && !errors.Is(executeErr, errRowLimitReached) {
			errMap := map[string]any{
				"type":    "error",
				"message": executeErr.Error(),
			}
			data, _ := json.Marshal(errMap)
			fmt.Fprintf(w, "%s\n", data)
			flusher.Flush()
			return
		}

		// Send completion status
		doneMap := map[string]any{
			"type":         "done",
			"rowsAffected": rowsAffected,
			"truncated":    truncated,
			"rowLimit":     limit,
		}
		data, _ := json.Marshal(doneMap)
		fmt.Fprintf(w, "%s\n", data)
		flusher.Flush()
	})
}

func (h *QueryHandler) ExecuteBatch() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		var req ExecuteBatchRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.ProfileID == "" || len(req.Statements) == 0 {
			http.Error(w, "profileId and statements are required", http.StatusBadRequest)
			return
		}

		// Per-statement policy gate (each entry is a single statement).
		for _, stmt := range req.Statements {
			class := domain.ClassifyQuery(stmt)
			if !class.ReadOnly && !req.AllowWrite {
				writeQueryPolicyError(w, http.StatusForbidden, "read_only_blocked",
					"This statement may modify data and is blocked in read-only mode.", class.Verb)
				return
			}
			if class.Destructive && !req.ConfirmDestructive {
				writeQueryPolicyError(w, http.StatusConflict, "confirmation_required",
					"This is a destructive statement. Confirm to run it.", class.Verb)
				return
			}
		}

		profile, password, err := h.service.GetProfile(r.Context(), req.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		connector, err := h.getConnector(profile.Driver)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		rowsAffected, failedIndex, execErr := connector.ExecuteBatch(r.Context(), *profile, password, req.Statements)
		resp := map[string]any{
			"ok":           execErr == nil,
			"rowsAffected": rowsAffected,
			"failedIndex":  failedIndex,
		}
		if execErr != nil {
			resp["error"] = execErr.Error()
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
}

func (h *QueryHandler) CancelQuery() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		var req CancelQueryRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.QueryID == "" {
			http.Error(w, "queryId is required", http.StatusBadRequest)
			return
		}

		info, exists := h.service.CancelRegistry.Get(req.QueryID)
		if !exists {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"success":true,"message":"query already finished or not found"}`))
			return
		}

		// 1. Trigger Go context cancel
		info.CancelFn()

		// 2. Perform physical DB query cancellation in background
		go func() {
			profile, password, err := h.service.GetProfile(context.Background(), info.ProfileID)
			if err != nil {
				return
			}
			connector, err := h.getConnector(profile.Driver)
			if err != nil {
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = connector.CancelSession(ctx, *profile, password, info.SessionID)
		}()

		// Unregister
		h.service.CancelRegistry.Unregister(req.QueryID)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"success":true}`))
	})
}
