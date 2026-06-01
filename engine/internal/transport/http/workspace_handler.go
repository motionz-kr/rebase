package http

import (
	"encoding/json"
	"net/http"

	"github.com/smlee/database-local-engine/engine/internal/application"
)

type WorkspaceHandler struct {
	token   string
	service *application.WorkspaceService
}

func NewWorkspaceHandler(token string, service *application.WorkspaceService) *WorkspaceHandler {
	return &WorkspaceHandler{
		token:   token,
		service: service,
	}
}

func (h *WorkspaceHandler) checkToken(r *http.Request) bool {
	reqToken := r.Header.Get("X-App-Engine-Token")
	return validToken(reqToken, h.token)
}

// Workspaces
func (h *WorkspaceHandler) SaveWorkspace() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		var req struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		ws, err := h.service.SaveWorkspace(r.Context(), req.ID, req.Name)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(ws)
	})
}

func (h *WorkspaceHandler) ListWorkspaces() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		list, err := h.service.ListWorkspaces(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(list)
	})
}

// Saved Queries
func (h *WorkspaceHandler) SaveQuery() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		var req struct {
			ID          string `json:"id"`
			WorkspaceID string `json:"workspaceId"`
			ProfileID   string `json:"profileId"`
			Name        string `json:"name"`
			QueryText   string `json:"queryText"`
			IsFavorite  bool   `json:"isFavorite"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		q, err := h.service.SaveQuery(r.Context(), req.ID, req.WorkspaceID, req.ProfileID, req.Name, req.QueryText, req.IsFavorite)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(q)
	})
}

func (h *WorkspaceHandler) DeleteQuery() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		id := r.URL.Query().Get("id")
		if id == "" {
			http.Error(w, "id parameter is required", http.StatusBadRequest)
			return
		}

		if err := h.service.DeleteQuery(r.Context(), id); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"success":true}`))
	})
}

func (h *WorkspaceHandler) ListQueries() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		workspaceID := r.URL.Query().Get("workspaceId")
		if workspaceID == "" {
			http.Error(w, "workspaceId parameter is required", http.StatusBadRequest)
			return
		}

		list, err := h.service.ListQueries(r.Context(), workspaceID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(list)
	})
}

// Query History
func (h *WorkspaceHandler) AddHistory() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		var req struct {
			WorkspaceID  string  `json:"workspaceId"`
			ProfileID    string  `json:"profileId"`
			QueryText    string  `json:"queryText"`
			DurationMs   int64   `json:"durationMs"`
			Success      bool    `json:"success"`
			ErrorMessage *string `json:"errorMessage"`
			RowCount     *int64  `json:"rowCount"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		entry, err := h.service.AddHistory(r.Context(), req.WorkspaceID, req.ProfileID, req.QueryText, req.DurationMs, req.Success, req.ErrorMessage, req.RowCount)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(entry)
	})
}

func (h *WorkspaceHandler) ListHistory() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		workspaceID := r.URL.Query().Get("workspaceId")
		profileID := r.URL.Query().Get("profileId")
		if workspaceID == "" || profileID == "" {
			http.Error(w, "workspaceId and profileId parameters are required", http.StatusBadRequest)
			return
		}

		list, err := h.service.ListHistory(r.Context(), workspaceID, profileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(list)
	})
}

// Phase 8: Account & MCP settings HTTP mapping
func (h *WorkspaceHandler) HandleAccount() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		acc, err := h.service.GetAccount(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(acc)
	})
}

func (h *WorkspaceHandler) HandleMCPSettings() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		if r.Method == http.MethodPost {
			var req struct {
				Enabled    bool     `json:"enabled"`
				AllowedDBs []string `json:"allowedDbs"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			settings, err := h.service.SaveMCPSettings(r.Context(), req.Enabled, req.AllowedDBs)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(settings)
			return
		}

		// GET case
		settings, err := h.service.GetMCPSettings(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(settings)
	})
}
