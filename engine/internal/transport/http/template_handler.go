package http

import (
	"encoding/json"
	"net/http"

	"github.com/smlee/database-local-engine/engine/internal/application"
)

type TemplateHandler struct {
	token   string
	service *application.TemplateService
}

func NewTemplateHandler(token string, service *application.TemplateService) *TemplateHandler {
	return &TemplateHandler{token: token, service: service}
}

func (h *TemplateHandler) checkToken(r *http.Request) bool {
	return validToken(r.Header.Get("X-App-Engine-Token"), h.token)
}

func (h *TemplateHandler) Save() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ID          string `json:"id"`
			WorkspaceID string `json:"workspaceId"`
			Name        string `json:"name"`
			Description string `json:"description"`
			Category    string `json:"category"`
			SQLText     string `json:"sqlText"`
			Parameters  string `json:"parameters"`
			Driver      string `json:"driver"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		t, err := h.service.SaveTemplate(r.Context(), body.ID, body.WorkspaceID, body.Name, body.Description, body.Category, body.SQLText, body.Parameters, body.Driver)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(t)
	})
}

func (h *TemplateHandler) List() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		workspaceID := r.URL.Query().Get("workspaceId")
		if workspaceID == "" {
			http.Error(w, "workspaceId is required", http.StatusBadRequest)
			return
		}
		list, err := h.service.ListTemplates(r.Context(), workspaceID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(list)
	})
}

func (h *TemplateHandler) Delete() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		id := r.URL.Query().Get("id")
		if id == "" {
			http.Error(w, "id is required", http.StatusBadRequest)
			return
		}
		if err := h.service.DeleteTemplate(r.Context(), id); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"success":true}`))
	})
}
