package http

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/smlee/database-local-engine/engine/internal/adapters/redis"
	"github.com/smlee/database-local-engine/engine/internal/application"
)

type RedisHandler struct {
	token          string
	service        *application.ConnectionService
	redisConnector *redis.RedisConnector
}

func NewRedisHandler(token string, service *application.ConnectionService) *RedisHandler {
	return &RedisHandler{
		token:          token,
		service:        service,
		redisConnector: redis.NewRedisConnector(),
	}
}

func (h *RedisHandler) checkToken(r *http.Request) bool {
	reqToken := r.Header.Get("X-App-Engine-Token")
	return validToken(reqToken, h.token)
}

func (h *RedisHandler) ScanKeys() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		profileID := r.URL.Query().Get("profileId")
		pattern := r.URL.Query().Get("pattern")
		cursorStr := r.URL.Query().Get("cursor")
		countStr := r.URL.Query().Get("count")

		if profileID == "" {
			http.Error(w, "profileId parameter is required", http.StatusBadRequest)
			return
		}

		cursor, _ := strconv.ParseUint(cursorStr, 10, 64)
		count, _ := strconv.ParseInt(countStr, 10, 64)

		profile, password, err := h.service.GetProfile(r.Context(), profileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		info, err := h.redisConnector.ScanKeys(r.Context(), *profile, password, pattern, cursor, count)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(info)
	})
}

func (h *RedisHandler) GetKeyValue() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		profileID := r.URL.Query().Get("profileId")
		key := r.URL.Query().Get("key")

		if profileID == "" || key == "" {
			http.Error(w, "profileId and key parameters are required", http.StatusBadRequest)
			return
		}

		profile, password, err := h.service.GetProfile(r.Context(), profileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		info, err := h.redisConnector.GetKeyValue(r.Context(), *profile, password, key)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(info)
	})
}

// SetString handles POST /redis/set with body {profileId, key, value}.
func (h *RedisHandler) SetString() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID string `json:"profileId"`
			Key       string `json:"key"`
			Value     string `json:"value"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if body.ProfileID == "" || body.Key == "" {
			http.Error(w, "profileId and key are required", http.StatusBadRequest)
			return
		}
		profile, password, err := h.service.GetProfile(r.Context(), body.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := h.redisConnector.SetString(r.Context(), *profile, password, body.Key, body.Value); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})
}

// DeleteKey handles POST /redis/del with body {profileId, key}.
func (h *RedisHandler) DeleteKey() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID string `json:"profileId"`
			Key       string `json:"key"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if body.ProfileID == "" || body.Key == "" {
			http.Error(w, "profileId and key are required", http.StatusBadRequest)
			return
		}
		profile, password, err := h.service.GetProfile(r.Context(), body.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		existed, err := h.redisConnector.DeleteKey(r.Context(), *profile, password, body.Key)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"existed": existed})
	})
}

// SetTTL handles POST /redis/expire with body {profileId, key, seconds}.
// A negative seconds value clears the expiry (PERSIST).
func (h *RedisHandler) SetTTL() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID string `json:"profileId"`
			Key       string `json:"key"`
			Seconds   int64  `json:"seconds"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if body.ProfileID == "" || body.Key == "" {
			http.Error(w, "profileId and key are required", http.StatusBadRequest)
			return
		}
		profile, password, err := h.service.GetProfile(r.Context(), body.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := h.redisConnector.SetTTL(r.Context(), *profile, password, body.Key, body.Seconds); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})
}

// RenameKey handles POST /redis/rename with body {profileId, key, newKey}.
func (h *RedisHandler) RenameKey() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID string `json:"profileId"`
			Key       string `json:"key"`
			NewKey    string `json:"newKey"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if body.ProfileID == "" || body.Key == "" || body.NewKey == "" {
			http.Error(w, "profileId, key and newKey are required", http.StatusBadRequest)
			return
		}
		profile, password, err := h.service.GetProfile(r.Context(), body.ProfileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := h.redisConnector.RenameKey(r.Context(), *profile, password, body.Key, body.NewKey); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})
}
