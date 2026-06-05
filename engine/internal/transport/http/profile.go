package http

import (
	"encoding/json"
	"net/http"

	"github.com/smlee/database-local-engine/engine/internal/adapters/mysql"
	"github.com/smlee/database-local-engine/engine/internal/adapters/postgres"
	"github.com/smlee/database-local-engine/engine/internal/adapters/redis"
	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlite"
	"github.com/smlee/database-local-engine/engine/internal/application"
	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type ProfileHandler struct {
	token             string
	service           *application.ConnectionService
	mysqlConnector    *mysql.MySQLConnector
	postgresConnector *postgres.PostgreSQLConnector
	redisConnector    *redis.RedisConnector
	sqliteConnector   *sqlite.SQLiteConnector
}

func NewProfileHandler(token string, service *application.ConnectionService) *ProfileHandler {
	return &ProfileHandler{
		token:             token,
		service:           service,
		mysqlConnector:    mysql.NewMySQLConnector(),
		postgresConnector: postgres.NewPostgreSQLConnector(),
		redisConnector:    redis.NewRedisConnector(),
		sqliteConnector:   sqlite.NewSQLiteConnector(),
	}
}

type ProfileRequest struct {
	Profile  domain.ConnectionProfile `json:"profile"`
	Password string                   `json:"password"`
}

func (h *ProfileHandler) checkToken(r *http.Request) bool {
	reqToken := r.Header.Get("X-App-Engine-Token")
	return validToken(reqToken, h.token)
}

func (h *ProfileHandler) CreateProfile() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		var req ProfileRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		if err := h.service.CreateProfile(r.Context(), &req.Profile, req.Password); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(req.Profile)
	})
}

func (h *ProfileHandler) UpdateProfile() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		var req ProfileRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if req.Profile.ID == "" {
			http.Error(w, "profile id is required", http.StatusBadRequest)
			return
		}

		if err := h.service.UpdateProfile(r.Context(), &req.Profile, req.Password); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(req.Profile)
	})
}

func (h *ProfileHandler) ListProfiles() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		list, err := h.service.ListProfiles(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(list)
	})
}

func (h *ProfileHandler) DeleteProfile() http.Handler {
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

		if err := h.service.DeleteProfile(r.Context(), id); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"success":true}`))
	})
}

func (h *ProfileHandler) TestConnection() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		var req ProfileRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		password := req.Password
		profile := req.Profile

		// If password is empty and profile ID is present, resolve it from the Keychain/DB
		if profile.ID != "" && password == "" {
			dbProfile, keyPassword, getErr := h.service.GetProfile(r.Context(), profile.ID)
			if getErr == nil && keyPassword != "" {
				password = keyPassword
				profile = *dbProfile
			}
		}

		var err error
		switch profile.Driver {
		case "mysql":
			err = h.mysqlConnector.TestConnection(r.Context(), profile, password)
		case "postgres":
			err = h.postgresConnector.TestConnection(r.Context(), profile, password)
		case "redis":
			err = h.redisConnector.TestConnection(r.Context(), profile, password)
		case "sqlite":
			err = h.sqliteConnector.TestConnection(r.Context(), profile, password)
		default:
			http.Error(w, "unsupported driver: "+req.Profile.Driver, http.StatusBadRequest)
			return
		}

		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnprocessableEntity)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"success":true}`))
	})
}
