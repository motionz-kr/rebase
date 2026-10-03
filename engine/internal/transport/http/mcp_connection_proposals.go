package http

import (
	"encoding/json"
	"net/http"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type MCPConnectionProposalHandler struct {
	token   string
	service ports.MCPConnectionProposalUseCase
}

func NewMCPConnectionProposalHandler(token string, service ports.MCPConnectionProposalUseCase) *MCPConnectionProposalHandler {
	return &MCPConnectionProposalHandler{token: token, service: service}
}

func (h *MCPConnectionProposalHandler) Handle() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !validToken(r.Header.Get("X-App-Engine-Token"), h.token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		switch r.Method {
		case http.MethodGet:
			status := r.URL.Query().Get("status")
			items, err := h.service.List(r.Context(), "default", status, 100)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(items)
		case http.MethodPost:
			var request struct {
				ID     string `json:"id"`
				Action string `json:"action"`
			}
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024)).Decode(&request); err != nil {
				http.Error(w, "invalid request", http.StatusBadRequest)
				return
			}
			if request.ID == "" || (request.Action != "applied" && request.Action != "reject") {
				http.Error(w, "proposal id and a supported action are required", http.StatusBadRequest)
				return
			}
			if err := h.service.Resolve(r.Context(), "default", request.ID, request.Action); err != nil {
				http.Error(w, err.Error(), http.StatusConflict)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
		default:
			w.Header().Set("Allow", "GET, POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
}
