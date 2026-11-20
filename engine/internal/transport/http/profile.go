package http

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"

	"github.com/smlee/database-local-engine/engine/internal/adapters/mongo"
	"github.com/smlee/database-local-engine/engine/internal/adapters/mysql"
	"github.com/smlee/database-local-engine/engine/internal/adapters/postgres"
	"github.com/smlee/database-local-engine/engine/internal/adapters/redis"
	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlite"
	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlserver"
	"github.com/smlee/database-local-engine/engine/internal/application"
	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type ProfileHandler struct {
	token              string
	service            *application.ConnectionService
	mysqlConnector     *mysql.MySQLConnector
	postgresConnector  *postgres.PostgreSQLConnector
	redisConnector     *redis.RedisConnector
	sqliteConnector    *sqlite.SQLiteConnector
	sqlserverConnector *sqlserver.SQLServerConnector
	mongoConnector     *mongo.MongoConnector
}

func NewProfileHandler(token string, service *application.ConnectionService) *ProfileHandler {
	return &ProfileHandler{
		token:              token,
		service:            service,
		mysqlConnector:     mysql.NewMySQLConnector(service),
		postgresConnector:  postgres.NewPostgreSQLConnector(service),
		redisConnector:     redis.NewRedisConnector(),
		sqliteConnector:    sqlite.NewSQLiteConnector(),
		sqlserverConnector: sqlserver.NewSQLServerConnector(service),
		mongoConnector:     mongo.NewMongoConnector(),
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

// DisconnectProfile closes the tunnel/proxy owned by a saved profile.
func (h *ProfileHandler) DisconnectProfile() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		id := r.URL.Query().Get("id")
		if id == "" {
			http.Error(w, "id parameter is required", http.StatusBadRequest)
			return
		}
		h.service.CloseProfileTunnel(id)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"success":true}`))
	})
}

func sameCloudSQLRoute(a, b domain.ConnectionProfile) bool {
	if a.ConnectionMode != b.ConnectionMode {
		return false
	}
	switch {
	case a.GCPCloudSQL == nil && b.GCPCloudSQL == nil:
		return true
	case a.GCPCloudSQL == nil || b.GCPCloudSQL == nil:
		return false
	}
	return *a.GCPCloudSQL == *b.GCPCloudSQL
}

// connectionTestRoutingID picks the tunnel owner for a connection test. A Cloud
// SQL test of an edited saved profile (route differs from the saved one, or
// the saved profile is another mode / missing) gets an ephemeral owner so it
// neither reuses nor terminates the saved connection's proxy. An unchanged
// route keeps the saved ID and shares its proxy. Other modes keep the ID.
func connectionTestRoutingID(submitted domain.ConnectionProfile, saved *domain.ConnectionProfile) string {
	if submitted.ConnectionMode != "gcp_cloudsql" || submitted.ID == "" {
		return submitted.ID
	}
	if saved != nil && sameCloudSQLRoute(*saved, submitted) {
		return submitted.ID
	}
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "connection-test-" + hex.EncodeToString(b[:])
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
			_, keyPassword, getErr := h.service.GetProfile(r.Context(), profile.ID)
			if getErr != nil {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(map[string]string{"error": getErr.Error()})
				return
			}
			if keyPassword != "" {
				password = keyPassword
			}
		}

		if profile.ID == "" {
			defer h.service.CloseProfileTunnel("")
		} else if profile.ConnectionMode == "gcp_cloudsql" {
			saved, _, _ := h.service.GetProfile(r.Context(), profile.ID)
			if routingID := connectionTestRoutingID(profile, saved); routingID != profile.ID {
				profile.ID = routingID
				defer h.service.CloseProfileTunnel(routingID)
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
		case "sqlserver":
			err = h.sqlserverConnector.TestConnection(r.Context(), profile, password)
		case "mongodb":
			err = h.mongoConnector.TestConnection(r.Context(), profile, password)
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
