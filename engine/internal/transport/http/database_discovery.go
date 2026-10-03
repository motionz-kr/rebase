package http

import (
	"encoding/json"
	"net/http"

	"github.com/smlee/database-local-engine/engine/internal/application"
)

type DatabaseDiscoveryHandler struct {
	token   string
	service *application.DatabaseDiscoveryService
}

func NewDatabaseDiscoveryHandler(token string, service *application.DatabaseDiscoveryService) *DatabaseDiscoveryHandler {
	return &DatabaseDiscoveryHandler{token: token, service: service}
}

func (h *DatabaseDiscoveryHandler) Discover() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if !validToken(r.Header.Get("X-App-Engine-Token"), h.token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		result, err := h.service.Discover(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(result); err != nil {
			return
		}
	})
}
