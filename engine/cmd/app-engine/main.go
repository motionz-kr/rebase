package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/adapters/keychain"
	"github.com/smlee/database-local-engine/engine/internal/adapters/mcp"
	"github.com/smlee/database-local-engine/engine/internal/adapters/mysql"
	"github.com/smlee/database-local-engine/engine/internal/adapters/postgres"
	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlite"
	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlserver"
	"github.com/smlee/database-local-engine/engine/internal/agent"
	"github.com/smlee/database-local-engine/engine/internal/application"
	"github.com/smlee/database-local-engine/engine/internal/ports"
	internalHttp "github.com/smlee/database-local-engine/engine/internal/transport/http"
	_ "modernc.org/sqlite"
)

type HandshakeInfo struct {
	Port      int       `json:"port"`
	PID       int       `json:"pid"`
	Ready     bool      `json:"ready"`
	StartedAt time.Time `json:"startedAt"`
}

// corsGuard rejects browser-originated cross-origin requests. The trusted
// client (the Electron main process via Node's http client) never sends an
// Origin header; any request that carries one is a cross-origin caller hitting
// the loopback engine and is refused regardless of the auth token.
func corsGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "" {
			http.Error(w, "cross-origin requests are not allowed", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	token := flag.String("token", "", "launch token for API authentication")
	handshakePath := flag.String("handshake", "", "file path to write handshake information")
	dbPath := flag.String("db", "", "SQLite database file path")
	mcpProfile := flag.String("mcp", "", "run as an MCP stdio server exposing DB tools for this profile id")
	flag.Parse()

	if *token == "" {
		log.Fatal("token flag is required")
	}
	if *handshakePath == "" {
		log.Fatal("handshake flag is required")
	}

	// 1. Initialize SQLite Database
	actualDBPath := *dbPath
	if actualDBPath == "" {
		homeDir, err := os.UserHomeDir()
		if err != nil {
			log.Fatalf("failed to get user home dir: %v", err)
		}
		appDir := filepath.Join(homeDir, ".antigravity")
		_ = os.MkdirAll(appDir, 0755)
		actualDBPath = filepath.Join(appDir, "metadata.db")
	}

	log.Printf("Using SQLite database: %s", actualDBPath)
	db, err := sql.Open("sqlite", actualDBPath)
	if err != nil {
		log.Fatalf("failed to open sqlite database: %v", err)
	}
	defer db.Close()

	// 2. Run Database Migrations
	migrationRunner := sqlite.NewMigrationRunner(db)
	migrations := []sqlite.Migration{
		{
			Version: 1,
			Name:    "create_connection_profiles",
			SQL: `
				CREATE TABLE IF NOT EXISTS connection_profiles (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					driver TEXT NOT NULL,
					host TEXT NOT NULL,
					port INTEGER NOT NULL,
					database TEXT NOT NULL,
					username TEXT NOT NULL,
					secret_ref TEXT NOT NULL,
					tls_mode TEXT NOT NULL,
					created_at DATETIME NOT NULL,
					updated_at DATETIME NOT NULL
				);
			`,
			Checksum: "profiles-v1",
		},
		{
			Version: 2,
			Name:    "create_workspace_saved_queries_history",
			SQL: `
				CREATE TABLE IF NOT EXISTS workspaces (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					remote_id TEXT,
					version INTEGER NOT NULL DEFAULT 1,
					sync_state TEXT NOT NULL DEFAULT 'local',
					created_at DATETIME NOT NULL,
					updated_at DATETIME NOT NULL
				);
				CREATE TABLE IF NOT EXISTS saved_queries (
					id TEXT PRIMARY KEY,
					workspace_id TEXT NOT NULL,
					profile_id TEXT NOT NULL,
					name TEXT NOT NULL,
					query_text TEXT NOT NULL,
					is_favorite INTEGER NOT NULL DEFAULT 0,
					remote_id TEXT,
					version INTEGER NOT NULL DEFAULT 1,
					sync_state TEXT NOT NULL DEFAULT 'local',
					created_at DATETIME NOT NULL,
					updated_at DATETIME NOT NULL,
					FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
					FOREIGN KEY (profile_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
				);
				CREATE TABLE IF NOT EXISTS query_history (
					id TEXT PRIMARY KEY,
					workspace_id TEXT NOT NULL,
					profile_id TEXT NOT NULL,
					query_text TEXT NOT NULL,
					executed_at DATETIME NOT NULL,
					duration_ms INTEGER NOT NULL,
					success INTEGER NOT NULL,
					error_message TEXT,
					row_count INTEGER,
					remote_id TEXT,
					version INTEGER NOT NULL DEFAULT 1,
					sync_state TEXT NOT NULL DEFAULT 'local',
					FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
					FOREIGN KEY (profile_id) REFERENCES connection_profiles(id) ON DELETE CASCADE
				);
				INSERT OR IGNORE INTO workspaces (id, name, remote_id, version, sync_state, created_at, updated_at)
				VALUES ('default', 'Default Workspace', NULL, 1, 'local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
			`,
			Checksum: "workspace-queries-v1",
		},
		{
			Version: 3,
			Name:    "add_profile_mcp_settings",
			SQL: `
				ALTER TABLE connection_profiles ADD COLUMN mcp_enabled INTEGER NOT NULL DEFAULT 0;
				ALTER TABLE connection_profiles ADD COLUMN mcp_data_exposure TEXT NOT NULL DEFAULT 'metadata';
			`,
			Checksum: "profile-mcp-settings-v1",
		},
		{
			Version: 4,
			Name:    "add_profile_read_only",
			SQL: `
				ALTER TABLE connection_profiles ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0;
			`,
			Checksum: "profile-read-only-v1",
		},
		{
			Version: 5,
			Name:    "add_profile_connection_uri",
			SQL: `
				ALTER TABLE connection_profiles ADD COLUMN connection_uri TEXT NOT NULL DEFAULT '';
			`,
			Checksum: "profile-connection-uri-v1",
		},
		{
			Version: 6,
			Name:    "add_profile_safe_mode",
			SQL: `
				ALTER TABLE connection_profiles ADD COLUMN safe_mode INTEGER NOT NULL DEFAULT 0;
				ALTER TABLE connection_profiles ADD COLUMN tenant_columns TEXT NOT NULL DEFAULT '';
			`,
			Checksum: "profile-safe-mode-v1",
		},
		{
			Version: 7,
			Name:    "add_profile_domain_bindings",
			SQL: `
				ALTER TABLE connection_profiles ADD COLUMN domain_bindings TEXT NOT NULL DEFAULT '';
			`,
			Checksum: "profile-domain-bindings-v1",
		},
		{
			Version: 8,
			Name:    "create_templates",
			SQL: `
				CREATE TABLE IF NOT EXISTS templates (
					id TEXT PRIMARY KEY,
					workspace_id TEXT NOT NULL,
					name TEXT NOT NULL,
					description TEXT NOT NULL DEFAULT '',
					category TEXT NOT NULL DEFAULT '',
					sql_text TEXT NOT NULL,
					parameters TEXT NOT NULL DEFAULT '[]',
					driver TEXT NOT NULL DEFAULT '',
					created_at DATETIME NOT NULL,
					updated_at DATETIME NOT NULL,
					FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
				);
			`,
			Checksum: "templates-v1",
		},
	}
	if err := migrationRunner.Run(migrations); err != nil {
		log.Fatalf("failed to run migrations: %v", err)
	}

	// 3. Setup Services
	profileRepo := sqlite.NewSQLiteProfileRepository(db)
	secretStore := keychain.NewKeyringStore("AntigravityDBDesktop")
	connectionService := application.NewConnectionService(profileRepo, secretStore)

	// MCP mode: serve the DB tool registry over stdio (for a local CLI like
	// `claude --mcp-config`) instead of the HTTP API, then exit.
	if *mcpProfile != "" {
		runMCPServer(connectionService, *mcpProfile)
		return
	}

	workspaceRepo := sqlite.NewSQLiteWorkspaceRepository(db)
	workspaceService := application.NewWorkspaceService(workspaceRepo)

	// 4. Bind HTTP server to random port
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatalf("failed to listen: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port

	// 5. Register HTTP Handlers
	mux := http.NewServeMux()
	mux.Handle("/health", internalHttp.NewHealthHandler(*token))

	profileHandler := internalHttp.NewProfileHandler(*token, connectionService)
	mux.Handle("/profiles", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			profileHandler.CreateProfile().ServeHTTP(w, r)
		case http.MethodGet:
			profileHandler.ListProfiles().ServeHTTP(w, r)
		case http.MethodDelete:
			profileHandler.DeleteProfile().ServeHTTP(w, r)
		case http.MethodPut:
			profileHandler.UpdateProfile().ServeHTTP(w, r)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}))
	mux.Handle("/connection-test", profileHandler.TestConnection())

	introHandler := internalHttp.NewIntrospectionHandler(*token, connectionService)
	mux.Handle("/databases", introHandler.ListDatabases())
	mux.Handle("/tables", introHandler.ListTables())
	mux.Handle("/describe-table", introHandler.DescribeTable())
	mux.Handle("/table-ddl", introHandler.TableDDL())
	mux.Handle("/views", introHandler.ListViews())
	mux.Handle("/view-ddl", introHandler.ViewDDL())
	mux.Handle("/foreign-keys", introHandler.ForeignKeys())
	mux.Handle("/indexes", introHandler.Indexes())
	mux.Handle("/schema-completion", introHandler.SchemaCompletion())
	mux.Handle("/schema-graph", introHandler.SchemaGraph())

	queryHandler := internalHttp.NewQueryHandler(*token, connectionService)
	mux.Handle("/query/execute", queryHandler.ExecuteQuery())
	mux.Handle("/query/execute-batch", queryHandler.ExecuteBatch())
	mux.Handle("/query/cancel", queryHandler.CancelQuery())
	mux.Handle("/query/analyze", queryHandler.AnalyzeQuery())

	redisHandler := internalHttp.NewRedisHandler(*token, connectionService)
	mux.Handle("/redis/scan", redisHandler.ScanKeys())
	mux.Handle("/redis/value", redisHandler.GetKeyValue())
	mux.Handle("/redis/set", redisHandler.SetString())
	mux.Handle("/redis/del", redisHandler.DeleteKey())
	mux.Handle("/redis/expire", redisHandler.SetTTL())
	mux.Handle("/redis/rename", redisHandler.RenameKey())
	mux.Handle("/redis/command", redisHandler.RunCommand())

	mongoHandler := internalHttp.NewMongoHandler(*token, connectionService)
	mux.Handle("/mongo/", mongoHandler.Routes())

	agentHandler := internalHttp.NewAgentHandler(*token, connectionService)
	mux.Handle("/agent/run", agentHandler.Run())
	mux.Handle("/agent/key", agentHandler.Key())
	mux.Handle("/agent/oauth/", agentHandler.OAuth())
	mux.Handle("/mcp/connection", agentHandler.SetMCPConnection())

	workspaceHandler := internalHttp.NewWorkspaceHandler(*token, workspaceService)
	mux.Handle("/workspaces", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			workspaceHandler.SaveWorkspace().ServeHTTP(w, r)
		case http.MethodGet:
			workspaceHandler.ListWorkspaces().ServeHTTP(w, r)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}))
	mux.Handle("/saved-queries", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			workspaceHandler.SaveQuery().ServeHTTP(w, r)
		case http.MethodGet:
			workspaceHandler.ListQueries().ServeHTTP(w, r)
		case http.MethodDelete:
			workspaceHandler.DeleteQuery().ServeHTTP(w, r)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}))
	mux.Handle("/query-history", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			workspaceHandler.AddHistory().ServeHTTP(w, r)
		case http.MethodGet:
			workspaceHandler.ListHistory().ServeHTTP(w, r)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}))
	mux.Handle("/account", workspaceHandler.HandleAccount())
	mux.Handle("/mcp/settings", workspaceHandler.HandleMCPSettings())

	templateRepo := sqlite.NewSQLiteTemplateRepository(db)
	templateService := application.NewTemplateService(templateRepo)
	templateHandler := internalHttp.NewTemplateHandler(*token, templateService)
	mux.Handle("/templates", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			templateHandler.Save().ServeHTTP(w, r)
		case http.MethodGet:
			templateHandler.List().ServeHTTP(w, r)
		case http.MethodDelete:
			templateHandler.Delete().ServeHTTP(w, r)
		default:
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}))

	server := &http.Server{
		Handler: corsGuard(mux),
		// Bound idle/slow connections. WriteTimeout is intentionally left unset:
		// the NDJSON query stream is long-lived and a global write deadline would
		// truncate large result sets mid-stream.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	serverErrChan := make(chan error, 1)
	go func() {
		log.Printf("Starting engine on 127.0.0.1:%d", port)
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			serverErrChan <- err
		}
	}()

	// 6. Write Handshake file
	info := HandshakeInfo{
		Port:      port,
		PID:       os.Getpid(),
		Ready:     true,
		StartedAt: time.Now(),
	}

	infoBytes, err := json.Marshal(info)
	if err != nil {
		log.Fatalf("failed to marshal handshake info: %v", err)
	}

	tmpPath := *handshakePath + ".tmp"
	if err := os.WriteFile(tmpPath, infoBytes, 0644); err != nil {
		log.Fatalf("failed to write temp handshake file: %v", err)
	}
	if err := os.Rename(tmpPath, *handshakePath); err != nil {
		log.Fatalf("failed to rename handshake file: %v", err)
	}
	log.Printf("Handshake written to %s", *handshakePath)

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-sigChan:
		log.Printf("Received signal %v, shutting down...", sig)
	case err := <-serverErrChan:
		log.Printf("Server error: %v, shutting down...", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Printf("Server shutdown error: %v", err)
	}

	_ = os.Remove(*handshakePath)
	log.Println("Engine stopped.")
}

// runMCPServer serves the agent's DB tool registry over stdio as an MCP server
// for the given profile, then returns when stdin closes.
func runMCPServer(svc *application.ConnectionService, profileID string) {
	ctx := context.Background()
	profile, password, err := svc.GetProfile(ctx, profileID)
	if err != nil {
		log.Fatalf("mcp: failed to load profile %s: %v", profileID, err)
	}
	var conn ports.SQLConnector
	switch profile.Driver {
	case "mysql":
		conn = mysql.NewMySQLConnector()
	case "postgres":
		conn = postgres.NewPostgreSQLConnector()
	case "sqlite":
		conn = sqlite.NewSQLiteConnector()
	case "sqlserver":
		conn = sqlserver.NewSQLServerConnector()
	default:
		log.Fatalf("mcp: unsupported driver %q (SQL drivers only)", profile.Driver)
	}
	if !profile.McpEnabled {
		log.Fatalf("mcp: connection %q is not enabled for MCP (enable it in Rebase → connection settings)", profileID)
	}
	registry := agent.NewSQLRegistry(conn, *profile, password, profile.Database)
	exposure := profile.McpDataExposure
	if exposure == "" {
		exposure = "metadata"
	}
	srv := mcp.NewServer(registry)
	srv.SetPolicy(agent.Policy{DataExposure: exposure}, []string{password, profile.SecretRef})
	if err := srv.Serve(ctx, os.Stdin, os.Stdout); err != nil {
		log.Fatalf("mcp: server error: %v", err)
	}
}
