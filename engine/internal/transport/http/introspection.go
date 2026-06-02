package http

import (
	"encoding/json"
	"net/http"

	"github.com/smlee/database-local-engine/engine/internal/adapters/mysql"
	"github.com/smlee/database-local-engine/engine/internal/adapters/postgres"
	"github.com/smlee/database-local-engine/engine/internal/application"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type IntrospectionHandler struct {
	token             string
	service           *application.ConnectionService
	mysqlConnector    *mysql.MySQLConnector
	postgresConnector *postgres.PostgreSQLConnector
}

func NewIntrospectionHandler(token string, service *application.ConnectionService) *IntrospectionHandler {
	return &IntrospectionHandler{
		token:             token,
		service:           service,
		mysqlConnector:    mysql.NewMySQLConnector(),
		postgresConnector: postgres.NewPostgreSQLConnector(),
	}
}

func (h *IntrospectionHandler) getConnector(driver string) (ports.SQLConnector, error) {
	switch driver {
	case "mysql":
		return h.mysqlConnector, nil
	case "postgres":
		return h.postgresConnector, nil
	default:
		return nil, fmtError("unsupported SQL driver: " + driver)
	}
}

type fmtError string

func (e fmtError) Error() string {
	return string(e)
}

func (h *IntrospectionHandler) checkToken(r *http.Request) bool {
	reqToken := r.Header.Get("X-App-Engine-Token")
	return validToken(reqToken, h.token)
}

func (h *IntrospectionHandler) ListDatabases() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		profileID := r.URL.Query().Get("profileId")
		if profileID == "" {
			http.Error(w, "profileId parameter is required", http.StatusBadRequest)
			return
		}

		profile, password, err := h.service.GetProfile(r.Context(), profileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		connector, err := h.getConnector(profile.Driver)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		dbs, err := connector.ListDatabases(r.Context(), *profile, password)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(dbs)
	})
}

func (h *IntrospectionHandler) ListTables() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		profileID := r.URL.Query().Get("profileId")
		database := r.URL.Query().Get("database")
		if profileID == "" || database == "" {
			http.Error(w, "profileId and database parameters are required", http.StatusBadRequest)
			return
		}

		profile, password, err := h.service.GetProfile(r.Context(), profileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		connector, err := h.getConnector(profile.Driver)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		tables, err := connector.ListTables(r.Context(), *profile, password, database)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(tables)
	})
}

func (h *IntrospectionHandler) DescribeTable() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		profileID := r.URL.Query().Get("profileId")
		database := r.URL.Query().Get("database")
		table := r.URL.Query().Get("table")
		if profileID == "" || database == "" || table == "" {
			http.Error(w, "profileId, database, and table parameters are required", http.StatusBadRequest)
			return
		}

		profile, password, err := h.service.GetProfile(r.Context(), profileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		connector, err := h.getConnector(profile.Driver)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		desc, err := connector.DescribeTable(r.Context(), *profile, password, database, table)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(desc)
	})
}

func (h *IntrospectionHandler) TableDDL() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		profileID := r.URL.Query().Get("profileId")
		database := r.URL.Query().Get("database")
		table := r.URL.Query().Get("table")
		if profileID == "" || database == "" || table == "" {
			http.Error(w, "profileId, database, and table parameters are required", http.StatusBadRequest)
			return
		}

		profile, password, err := h.service.GetProfile(r.Context(), profileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		connector, err := h.getConnector(profile.Driver)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		ddl, err := connector.GetTableDDL(r.Context(), *profile, password, database, table)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"ddl": ddl})
	})
}

func (h *IntrospectionHandler) ListViews() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		profileID := r.URL.Query().Get("profileId")
		database := r.URL.Query().Get("database")
		if profileID == "" || database == "" {
			http.Error(w, "profileId and database parameters are required", http.StatusBadRequest)
			return
		}
		profile, password, err := h.service.GetProfile(r.Context(), profileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		connector, err := h.getConnector(profile.Driver)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		views, err := connector.ListViews(r.Context(), *profile, password, database)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(views)
	})
}

func (h *IntrospectionHandler) ViewDDL() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		profileID := r.URL.Query().Get("profileId")
		database := r.URL.Query().Get("database")
		view := r.URL.Query().Get("view")
		if profileID == "" || database == "" || view == "" {
			http.Error(w, "profileId, database, and view parameters are required", http.StatusBadRequest)
			return
		}
		profile, password, err := h.service.GetProfile(r.Context(), profileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		connector, err := h.getConnector(profile.Driver)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		ddl, err := connector.GetViewDDL(r.Context(), *profile, password, database, view)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"ddl": ddl})
	})
}

func (h *IntrospectionHandler) ForeignKeys() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		profileID := r.URL.Query().Get("profileId")
		database := r.URL.Query().Get("database")
		table := r.URL.Query().Get("table")
		if profileID == "" || database == "" || table == "" {
			http.Error(w, "profileId, database, and table parameters are required", http.StatusBadRequest)
			return
		}
		profile, password, err := h.service.GetProfile(r.Context(), profileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		connector, err := h.getConnector(profile.Driver)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		fks, err := connector.ListForeignKeys(r.Context(), *profile, password, database, table)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(fks)
	})
}

func (h *IntrospectionHandler) SchemaCompletion() http.Handler {
	type completionColumn struct {
		Name string `json:"name"`
		Type string `json:"type"`
	}
	type completionTable struct {
		Name    string             `json:"name"`
		Columns []completionColumn `json:"columns"`
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		profileID := r.URL.Query().Get("profileId")
		database := r.URL.Query().Get("database")
		if profileID == "" || database == "" {
			http.Error(w, "profileId and database parameters are required", http.StatusBadRequest)
			return
		}

		profile, password, err := h.service.GetProfile(r.Context(), profileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		connector, err := h.getConnector(profile.Driver)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		cols, err := connector.ListColumns(r.Context(), *profile, password, database)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		// Group flat (table, column, type) rows into tables, preserving order.
		order := []string{}
		byTable := map[string]*completionTable{}
		for _, c := range cols {
			t, ok := byTable[c.Table]
			if !ok {
				t = &completionTable{Name: c.Table}
				byTable[c.Table] = t
				order = append(order, c.Table)
			}
			t.Columns = append(t.Columns, completionColumn{Name: c.Column, Type: c.Type})
		}
		tables := make([]completionTable, 0, len(order))
		for _, name := range order {
			tables = append(tables, *byTable[name])
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"tables": tables})
	})
}
