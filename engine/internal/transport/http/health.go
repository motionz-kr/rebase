package http

import (
	"encoding/json"
	"net/http"
)

type HealthResponse struct {
	Ready bool `json:"ready"`
}

func NewHealthHandler(token string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !validToken(r.Header.Get("X-App-Engine-Token"), token) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(HealthResponse{Ready: true})
	})
}
