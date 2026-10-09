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
	"sort"
	"syscall"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/adapters/discovery"
	"github.com/smlee/database-local-engine/engine/internal/adapters/keychain"
	"github.com/smlee/database-local-engine/engine/internal/adapters/mcp"
	"github.com/smlee/database-local-engine/engine/internal/adapters/mysql"
	"github.com/smlee/database-local-engine/engine/internal/adapters/postgres"
	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlite"
	"github.com/smlee/database-local-engine/engine/internal/adapters/sqlserver"
	"github.com/smlee/database-local-engine/engine/internal/adapters/tunnel"
	"github.com/smlee/database-local-engine/engine/internal/agent"
	"github.com/smlee/database-local-engine/engine/internal/application"
	"github.com/smlee/database-local-engine/engine/internal/domain"
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
	mcpProfile := flag.String("mcp", "", "run as an MCP stdio server for a profile id or 'all' MCP-enabled SQL profiles")
	flag.Parse()

	if *handshakePath == "" && *mcpProfile == "" {
		log.Fatal("handshake flag is required")
	}
	if *mcpProfile == "" && *token == "" {
		log.Fatal("token flag is required")
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
		{
			Version: 9,
			Name:    "add_profile_domain_glossary",
			SQL: `
				ALTER TABLE connection_profiles ADD COLUMN domain_glossary TEXT NOT NULL DEFAULT '';
				ALTER TABLE connection_profiles ADD COLUMN domain_notes TEXT NOT NULL DEFAULT '';
			`,
			Checksum: "profile-domain-glossary-v1",
		},
		{
			Version: 10,
			Name:    "create_mcp_servers",
			SQL: `
				CREATE TABLE IF NOT EXISTS mcp_servers (
					id TEXT PRIMARY KEY,
					workspace_id TEXT NOT NULL,
					name TEXT NOT NULL,
					command TEXT NOT NULL,
					args TEXT NOT NULL DEFAULT '[]',
					enabled INTEGER NOT NULL DEFAULT 1,
					trusted INTEGER NOT NULL DEFAULT 0,
					created_at DATETIME NOT NULL,
					updated_at DATETIME NOT NULL,
					FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
				);
			`,
			Checksum: "mcp-servers-v1",
		},
		{
			Version: 11,
			Name:    "add_mcp_server_transport",
			SQL: `
				ALTER TABLE mcp_servers ADD COLUMN transport TEXT NOT NULL DEFAULT 'stdio';
				ALTER TABLE mcp_servers ADD COLUMN url TEXT NOT NULL DEFAULT '';
			`,
			Checksum: "mcp-servers-transport-v1",
		},
		{
			Version: 12,
			Name:    "add_query_history_name",
			SQL: `
				ALTER TABLE query_history ADD COLUMN name TEXT NOT NULL DEFAULT '';
			`,
			Checksum: "query-history-name-v1",
		},
		{
			Version: 13,
			Name:    "add_mcp_access_scope",
			SQL: `
				ALTER TABLE connection_profiles ADD COLUMN mcp_allowed_databases TEXT NOT NULL DEFAULT '';
				ALTER TABLE connection_profiles ADD COLUMN mcp_allowed_schemas TEXT NOT NULL DEFAULT '';
				ALTER TABLE connection_profiles ADD COLUMN mcp_allowed_tables TEXT NOT NULL DEFAULT '';
			`,
			Checksum: "profile-mcp-access-scope-v1",
		},
		{
			Version: 14,
			Name:    "create_mcp_activity_events",
			SQL: `
				CREATE TABLE IF NOT EXISTS mcp_activity_events (
					id TEXT PRIMARY KEY,
					workspace_id TEXT NOT NULL,
					profile_id TEXT NOT NULL DEFAULT '',
					server_id TEXT NOT NULL DEFAULT '',
					direction TEXT NOT NULL,
					event TEXT NOT NULL,
					tool TEXT NOT NULL DEFAULT '',
					status TEXT NOT NULL,
					error_message TEXT NOT NULL DEFAULT '',
					duration_ms INTEGER NOT NULL DEFAULT 0,
					created_at DATETIME NOT NULL
				);
				CREATE INDEX IF NOT EXISTS idx_mcp_activity_profile_time ON mcp_activity_events(profile_id, created_at DESC);
				CREATE INDEX IF NOT EXISTS idx_mcp_activity_server_time ON mcp_activity_events(server_id, created_at DESC);
			`,
			Checksum: "mcp-activity-events-v1",
		},
		{
			Version: 15,
			Name:    "add_mcp_activity_query_text",
			SQL: `
				ALTER TABLE mcp_activity_events ADD COLUMN query_text TEXT NOT NULL DEFAULT '';
			`,
			Checksum: "mcp-activity-query-text-v1",
		},
		{
			Version: 16,
			Name:    "index_mcp_activity_workspace_time",
			SQL: `
				CREATE INDEX IF NOT EXISTS idx_mcp_activity_workspace_time ON mcp_activity_events(workspace_id, created_at DESC);
			`,
			Checksum: "mcp-activity-workspace-time-v1",
		},
		{
			Version: 17,
			Name:    "add_mcp_write_approval",
			SQL: `
				ALTER TABLE connection_profiles ADD COLUMN mcp_write_mode TEXT NOT NULL DEFAULT 'disabled';
				CREATE TABLE IF NOT EXISTS mcp_write_proposals (
					id TEXT PRIMARY KEY,
					workspace_id TEXT NOT NULL,
					profile_id TEXT NOT NULL,
					sql_text TEXT NOT NULL,
					risk TEXT NOT NULL,
					reasons_json TEXT NOT NULL DEFAULT '[]',
					status TEXT NOT NULL,
					rows_affected INTEGER NOT NULL DEFAULT 0,
					error_message TEXT NOT NULL DEFAULT '',
					created_at DATETIME NOT NULL,
					updated_at DATETIME NOT NULL,
					approved_at DATETIME,
					executed_at DATETIME
				);
				CREATE INDEX IF NOT EXISTS idx_mcp_write_profile_status ON mcp_write_proposals(profile_id, status, created_at DESC);
			`,
			Checksum: "mcp-write-approval-v1",
		},
	}
	migrations = append(migrations, sqlite.SSMProfileMigration)
	migrations = append(migrations, sqlite.Migration{
		Version: 19,
		Name:    "create_mcp_connection_proposals",
		SQL: `
			CREATE TABLE IF NOT EXISTS mcp_connection_proposals (
				id TEXT PRIMARY KEY,
				workspace_id TEXT NOT NULL,
				operation TEXT NOT NULL,
				target_profile_id TEXT NOT NULL DEFAULT '',
				result_profile_id TEXT NOT NULL DEFAULT '',
				target_updated_at DATETIME,
				candidate_id TEXT NOT NULL,
				name TEXT NOT NULL,
				driver TEXT NOT NULL,
				host TEXT NOT NULL,
				port INTEGER NOT NULL,
				database_name TEXT NOT NULL DEFAULT '',
				username TEXT NOT NULL DEFAULT '',
				tls_mode TEXT NOT NULL,
				source TEXT NOT NULL,
				source_name TEXT NOT NULL DEFAULT '',
				status TEXT NOT NULL,
				created_at DATETIME NOT NULL,
				updated_at DATETIME NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_mcp_connection_proposals_workspace_status ON mcp_connection_proposals(workspace_id, status, created_at DESC);
		`,
		Checksum: "mcp-connection-proposals-v1",
	})
	migrations = append(migrations, sqlite.SSHProfileMigration)
	if err := migrationRunner.Run(migrations); err != nil {
		log.Fatalf("failed to run migrations: %v", err)
	}

	// 3. Setup Services
	profileRepo := sqlite.NewSQLiteProfileRepository(db)
	secretStore := keychain.NewKeyringStore("AntigravityDBDesktop")
	connectionService := application.NewConnectionService(profileRepo, secretStore)
	tunnels := tunnel.NewManager()
	defer tunnels.Close()
	connectionService.SetTunnelManager(tunnels)
	mcpActivityRepo := sqlite.NewSQLiteMCPActivityRepository(db)
	mcpWriteRepo := sqlite.NewSQLiteMCPWriteProposalRepository(db)
	mcpConnectionProposalRepo := sqlite.NewSQLiteMCPConnectionProposalRepository(db)
	databaseDiscovery := application.NewDatabaseDiscoveryService(discovery.NewLocalDatabaseDiscovery())
	mcpConnectionProposals := application.NewMCPConnectionProposalService(mcpConnectionProposalRepo, profileRepo, databaseDiscovery)

	// MCP mode: serve the DB tool registry over stdio (for a local CLI like
	// `claude --mcp-config`) instead of the HTTP API, then exit.
	if *mcpProfile != "" {
		runMCPServer(connectionService, mcpActivityRepo, mcpWriteRepo, databaseDiscovery, mcpConnectionProposals, *mcpProfile)
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
	discoveryHandler := internalHttp.NewDatabaseDiscoveryHandler(*token, databaseDiscovery)
	mux.Handle("/database-discovery", discoveryHandler.Discover())
	mcpConnectionProposalHandler := internalHttp.NewMCPConnectionProposalHandler(*token, mcpConnectionProposals)
	mux.Handle("/mcp/connection-proposals", mcpConnectionProposalHandler.Handle())
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
	mux.Handle("/query/session", queryHandler.QuerySession())
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
	mcpServerRepo := sqlite.NewSQLiteMcpServerRepository(db)
	agentHandler.SetMCP(mcpServerRepo, secretStore, mcpActivityRepo)
	mcpServerHandler := internalHttp.NewMcpServerHandler(*token, mcpServerRepo, secretStore, mcpActivityRepo)
	mcpWriteHandler := internalHttp.NewMCPWriteHandler(*token, connectionService, mcpWriteRepo, mcpActivityRepo)
	mux.Handle("/agent/run", agentHandler.Run())
	mux.Handle("/agent/complete", agentHandler.Complete())
	mux.Handle("/agent/key", agentHandler.Key())
	mux.Handle("/agent/oauth/", agentHandler.OAuth())
	mux.Handle("/mcp/connection", agentHandler.SetMCPConnection())
	mux.Handle("/mcp/servers", mcpServerHandler.Servers())
	mux.Handle("/mcp/servers/test", mcpServerHandler.Test())
	mux.Handle("/mcp/servers/call", mcpServerHandler.Call())
	mux.Handle("/mcp/activity", mcpServerHandler.Activity())
	mux.Handle("/mcp/write-proposals", mcpWriteHandler.Proposals())

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

	tunnels.Close()
	if err := server.Shutdown(ctx); err != nil {
		log.Printf("Server shutdown error: %v", err)
	}

	_ = os.Remove(*handshakePath)
	log.Println("Engine stopped.")
}

// runMCPServer serves the agent's DB tool registry over stdio as an MCP server
// for the given profile, then returns when stdin closes.
func runMCPServer(svc *application.ConnectionService, activity ports.MCPActivityRepository, proposals ports.MCPWriteProposalRepository, discovery ports.DatabaseDiscovery, connectionProposals ports.MCPConnectionProposalUseCase, profileID string) {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if profileID == "all" {
		registry, secretProvider := buildUnifiedMCPRegistry(svc, proposals, discovery, connectionProposals)
		srv := mcp.NewServer(registry)
		srv.SetActivity(activity, "default", "all")
		srv.SetSecretProvider(secretProvider)
		if err := srv.Serve(ctx, os.Stdin, os.Stdout); err != nil {
			log.Printf("mcp: server error: %v", err)
		}
		return
	}

	profile, password, err := svc.GetProfile(ctx, profileID)
	if err != nil {
		log.Fatalf("mcp: failed to load profile %s: %v", profileID, err)
	}
	var conn ports.SQLConnector
	switch profile.Driver {
	case "mysql":
		conn = mysql.NewMySQLConnector(svc)
	case "postgres":
		conn = postgres.NewPostgreSQLConnector(svc)
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
	registry := agent.NewSQLRegistryWithMCPWrites(conn, *profile, password, profile.Database, agent.MCPWriteConfig{
		Mode: profile.McpWriteMode, WorkspaceID: "default", ProfileID: profileID, Proposals: proposals,
	})
	srv := mcp.NewServer(registry)
	srv.SetActivity(activity, "default", profileID)
	srv.SetSecrets([]string{password, profile.SecretRef})
	if err := srv.Serve(ctx, os.Stdin, os.Stdout); err != nil {
		log.Printf("mcp: server error: %v", err)
	}
}

func buildUnifiedMCPRegistry(svc *application.ConnectionService, proposals ports.MCPWriteProposalRepository, discovery ports.DatabaseDiscovery, connectionProposals ports.MCPConnectionProposalUseCase) (*agent.Registry, func(context.Context) []string) {
	fullAccessProfile := domain.ConnectionProfile{ID: "tool-schema-full-access", Driver: "mysql", McpWriteMode: domain.MCPWriteModeFullAccess}
	approvalProfile := domain.ConnectionProfile{ID: "tool-schema-approval", Driver: "mysql", McpWriteMode: domain.MCPWriteModeApproval}
	fullAccessRegistry := agent.NewSQLRegistryWithMCPWrites(mysql.NewMySQLConnector(svc), fullAccessProfile, "", "", agent.MCPWriteConfig{Mode: domain.MCPWriteModeFullAccess})
	approvalRegistry := agent.NewSQLRegistryWithMCPWrites(mysql.NewMySQLConnector(svc), approvalProfile, "", "", agent.MCPWriteConfig{Mode: domain.MCPWriteModeApproval, WorkspaceID: "default", ProfileID: approvalProfile.ID, Proposals: proposals})
	seedTargets := []agent.MCPConnectionTarget{
		{ID: fullAccessProfile.ID, Name: "tool-schema-full-access", Driver: fullAccessProfile.Driver, Registry: fullAccessRegistry},
		{ID: approvalProfile.ID, Name: "tool-schema-approval", Driver: approvalProfile.Driver, Registry: approvalRegistry},
	}
	resolveTargets := func(ctx context.Context) ([]agent.MCPConnectionTarget, error) {
		targets, _, err := loadUnifiedMCPProfiles(ctx, svc, proposals)
		return targets, err
	}
	listProfiles := func(ctx context.Context) ([]domain.ConnectionProfile, error) {
		return svc.ListProfiles(ctx)
	}
	registry := agent.NewMultiProfileRegistryWithManagement(seedTargets, resolveTargets, discovery, connectionProposals, listProfiles)
	secretProvider := func(ctx context.Context) []string {
		_, secrets, err := loadUnifiedMCPProfiles(ctx, svc, proposals)
		if err != nil {
			log.Printf("mcp: unable to refresh credential redaction values")
			return nil
		}
		return secrets
	}
	return registry, secretProvider
}

func loadUnifiedMCPProfiles(ctx context.Context, svc *application.ConnectionService, proposals ports.MCPWriteProposalRepository) ([]agent.MCPConnectionTarget, []string, error) {
	profiles, err := svc.ListProfiles(ctx)
	if err != nil {
		return nil, nil, err
	}
	sort.Slice(profiles, func(i, j int) bool {
		if profiles[i].Name == profiles[j].Name {
			return profiles[i].ID < profiles[j].ID
		}
		return profiles[i].Name < profiles[j].Name
	})

	targets := make([]agent.MCPConnectionTarget, 0, len(profiles))
	secrets := make([]string, 0, len(profiles)*2)
	for _, listed := range profiles {
		if !listed.McpEnabled {
			continue
		}
		profile, password, err := svc.GetProfile(ctx, listed.ID)
		if err != nil || profile == nil || !profile.McpEnabled {
			log.Printf("mcp: omitting an enabled connection that could not be loaded")
			continue
		}

		var conn ports.SQLConnector
		switch profile.Driver {
		case "mysql":
			conn = mysql.NewMySQLConnector(svc)
		case "postgres":
			conn = postgres.NewPostgreSQLConnector(svc)
		case "sqlite":
			conn = sqlite.NewSQLiteConnector()
		case "sqlserver":
			conn = sqlserver.NewSQLServerConnector()
		default:
			continue
		}

		registry := agent.NewSQLRegistryWithMCPWrites(conn, *profile, password, profile.Database, agent.MCPWriteConfig{
			Mode: profile.McpWriteMode, WorkspaceID: "default", ProfileID: profile.ID, Proposals: proposals,
		})
		secrets = append(secrets, password, profile.SecretRef)
		targets = append(targets, agent.MCPConnectionTarget{
			ID: profile.ID, Name: profile.Name, Driver: profile.Driver, Database: profile.Database, Registry: registry,
		})
	}
	return targets, secrets, nil
}
