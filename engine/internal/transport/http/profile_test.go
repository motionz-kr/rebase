package http

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/adapters/mysql"
	"github.com/smlee/database-local-engine/engine/internal/application"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type failingProfileSecretStore struct{ err error }

func (s failingProfileSecretStore) Get(context.Context, string) (string, error) { return "", s.err }
func (s failingProfileSecretStore) Set(context.Context, string, string) error   { return nil }
func (s failingProfileSecretStore) Delete(context.Context, string) error        { return nil }

func TestProfileTestConnectionSurfacesCredentialStoreErrors(t *testing.T) {
	ctx := context.Background()
	repo := ports.NewFakeProfileRepository()
	profile := &domain.ConnectionProfile{
		ID: "profile-1", Name: "Profile", Driver: "unsupported", SecretRef: "secret-profile-1",
	}
	if err := repo.Create(ctx, profile); err != nil {
		t.Fatalf("Create profile: %v", err)
	}
	service := application.NewConnectionService(repo, failingProfileSecretStore{err: errors.New("keychain access denied")})
	handler := NewProfileHandler("test-token", service)
	request := httptest.NewRequest(http.MethodPost, "/connection-test", strings.NewReader(
		`{"profile":{"id":"profile-1","driver":"unsupported"}}`,
	))
	request.Header.Set("X-App-Engine-Token", "test-token")
	response := httptest.NewRecorder()

	handler.TestConnection().ServeHTTP(response, request)

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, body %q; want %d for credential store failure", response.Code, response.Body.String(), http.StatusInternalServerError)
	}
	if !strings.Contains(response.Body.String(), "keychain access denied") {
		t.Errorf("body = %q, want credential store error", response.Body.String())
	}
}

type captureTestEndpoint struct{ host string }

func (c *captureTestEndpoint) ResolveEndpoint(_ context.Context, p domain.ConnectionProfile) (ports.ConnectionEndpoint, error) {
	c.host = p.Host
	return ports.ConnectionEndpoint{}, errors.New("captured endpoint")
}
func TestProfileTestConnectionUsesEditedRouteWithStoredPassword(t *testing.T) {
	ctx := context.Background()
	repo := ports.NewFakeProfileRepository()
	store := ports.NewFakeSecretStore()
	svc := application.NewConnectionService(repo, store)
	p := &domain.ConnectionProfile{ID: "edit", Name: "prod", Driver: "mysql", Host: "old.internal", Port: 3306, Database: "app"}
	if err := svc.CreateProfile(ctx, p, "saved-password"); err != nil {
		t.Fatal(err)
	}
	handler := NewProfileHandler("token", svc)
	capture := &captureTestEndpoint{}
	handler.mysqlConnector = mysql.NewMySQLConnector(capture)
	request := httptest.NewRequest(http.MethodPost, "/connection-test", strings.NewReader(`{"profile":{"id":"edit","name":"prod","driver":"mysql","host":"new.internal","port":3306,"database":"app"}}`))
	request.Header.Set("X-App-Engine-Token", "token")
	response := httptest.NewRecorder()
	handler.TestConnection().ServeHTTP(response, request)
	if capture.host != "new.internal" {
		t.Fatalf("tested stored host instead of edited host: %q", capture.host)
	}
}

type recordingTunnels struct {
	resolved []string
	closed   []string
}

func (r *recordingTunnels) ResolveEndpoint(_ context.Context, p domain.ConnectionProfile) (ports.ConnectionEndpoint, error) {
	r.resolved = append(r.resolved, p.ID)
	return ports.ConnectionEndpoint{}, errors.New("recorded endpoint")
}
func (r *recordingTunnels) CloseProfile(id string) { r.closed = append(r.closed, id) }

func TestDisconnectProfileClosesTunnel(t *testing.T) {
	svc := application.NewConnectionService(ports.NewFakeProfileRepository(), ports.NewFakeSecretStore())
	tunnels := &recordingTunnels{}
	svc.SetTunnelManager(tunnels)
	handler := NewProfileHandler("token", svc)

	call := func(token, target string) int {
		req := httptest.NewRequest(http.MethodPost, target, nil)
		if token != "" {
			req.Header.Set("X-App-Engine-Token", token)
		}
		rec := httptest.NewRecorder()
		handler.DisconnectProfile().ServeHTTP(rec, req)
		return rec.Code
	}
	if code := call("", "/profiles/disconnect?id=p1"); code != http.StatusUnauthorized {
		t.Fatalf("no token: %d", code)
	}
	if code := call("token", "/profiles/disconnect"); code != http.StatusBadRequest {
		t.Fatalf("no id: %d", code)
	}
	if len(tunnels.closed) != 0 {
		t.Fatalf("closed too early: %v", tunnels.closed)
	}
	if code := call("token", "/profiles/disconnect?id=p1"); code != http.StatusOK {
		t.Fatalf("ok: %d", code)
	}
	if len(tunnels.closed) != 1 || tunnels.closed[0] != "p1" {
		t.Fatalf("closed = %v", tunnels.closed)
	}
}

func cloudSQLTestRequest(t *testing.T, instance string) (*recordingTunnels, *ProfileHandler, *http.Request) {
	t.Helper()
	ctx := context.Background()
	svc := application.NewConnectionService(ports.NewFakeProfileRepository(), ports.NewFakeSecretStore())
	tunnels := &recordingTunnels{}
	svc.SetTunnelManager(tunnels)
	saved := &domain.ConnectionProfile{
		ID: "saved", Name: "cs", Driver: "mysql", Host: "h", Port: 3306, Database: "app", ConnectionMode: "gcp_cloudsql",
		GCPCloudSQL: &domain.GCPCloudSQLConfig{InstanceConnectionName: "my-project:asia-northeast3:db-1"},
	}
	if err := svc.CreateProfile(ctx, saved, "pw"); err != nil {
		t.Fatal(err)
	}
	handler := NewProfileHandler("token", svc)
	handler.mysqlConnector = mysql.NewMySQLConnector(svc)
	body := `{"profile":{"id":"saved","name":"cs","driver":"mysql","connectionMode":"gcp_cloudsql","host":"h","port":3306,"database":"app","gcpCloudSql":{"instanceConnectionName":"` + instance + `"}}}`
	req := httptest.NewRequest(http.MethodPost, "/connection-test", strings.NewReader(body))
	req.Header.Set("X-App-Engine-Token", "token")
	return tunnels, handler, req
}

func TestCloudSQLConnectionTestOfEditedRouteUsesEphemeralOwner(t *testing.T) {
	tunnels, handler, req := cloudSQLTestRequest(t, "my-project:asia-northeast3:db-2")
	handler.TestConnection().ServeHTTP(httptest.NewRecorder(), req)
	if len(tunnels.resolved) != 1 {
		t.Fatalf("resolved = %v", tunnels.resolved)
	}
	id := tunnels.resolved[0]
	if id == "saved" || !strings.HasPrefix(id, "connection-test-") {
		t.Fatalf("edited route must use an ephemeral routing ID, got %q", id)
	}
	if len(tunnels.closed) != 1 || tunnels.closed[0] != id {
		t.Fatalf("closed = %v, want only %q", tunnels.closed, id)
	}
}

func TestCloudSQLConnectionTestOfUnchangedRouteSharesSavedProxy(t *testing.T) {
	tunnels, handler, req := cloudSQLTestRequest(t, "my-project:asia-northeast3:db-1")
	handler.TestConnection().ServeHTTP(httptest.NewRecorder(), req)
	if len(tunnels.resolved) != 1 || tunnels.resolved[0] != "saved" {
		t.Fatalf("resolved = %v, want the saved ID", tunnels.resolved)
	}
	if len(tunnels.closed) != 0 {
		t.Fatalf("saved proxy must not be released by the test: %v", tunnels.closed)
	}
}

func TestConnectionTestRoutingID(t *testing.T) {
	cfg := &domain.GCPCloudSQLConfig{InstanceConnectionName: "p-12345:r-x1:i"}
	csql := domain.ConnectionProfile{ID: "x", ConnectionMode: "gcp_cloudsql", GCPCloudSQL: cfg}
	ssmP := domain.ConnectionProfile{ID: "x", ConnectionMode: "ssm", Host: "db", Port: 3306, SSM: &domain.SSMConfig{Region: "ap-northeast-2", InstanceID: "i-0123456789abcdef0"}}
	sshP := domain.ConnectionProfile{ID: "x", ConnectionMode: "ssh", Host: "db", Port: 3306, SSH: &domain.SSHConfig{Host: "b", Port: 22}}
	direct := domain.ConnectionProfile{ID: "x", Host: "db", Port: 3306}

	ephemeral := func(name string, submitted domain.ConnectionProfile, saved *domain.ConnectionProfile) {
		t.Helper()
		a, b := connectionTestRoutingID(submitted, saved), connectionTestRoutingID(submitted, saved)
		if a == "x" || a == b || !strings.HasPrefix(a, "connection-test-") {
			t.Errorf("%s: want unique ephemeral ids, got %q %q", name, a, b)
		}
	}
	keep := func(name string, submitted domain.ConnectionProfile, saved *domain.ConnectionProfile) {
		t.Helper()
		if got := connectionTestRoutingID(submitted, saved); got != "x" {
			t.Errorf("%s: identical route must keep id, got %q", name, got)
		}
	}
	if got := connectionTestRoutingID(domain.ConnectionProfile{ConnectionMode: "gcp_cloudsql"}, nil); got != "" {
		t.Errorf("unsaved id changed: %q", got)
	}
	// Saved Cloud SQL profile, submitted route differs in any way.
	ephemeral("gcp->direct", direct, &csql)
	ephemeral("gcp->ssh", sshP, &csql)
	ephemeral("gcp->ssm", ssmP, &csql)
	changed := csql
	changed.GCPCloudSQL = &domain.GCPCloudSQLConfig{InstanceConnectionName: cfg.InstanceConnectionName, PrivateIP: true}
	ephemeral("gcp changed", changed, &csql)
	ephemeral("missing saved", csql, nil)
	ephemeral("direct->gcp", csql, &direct)
	otherSSH := sshP
	otherSSH.SSH = &domain.SSHConfig{Host: "other", Port: 22}
	ephemeral("ssh changed", otherSSH, &sshP)
	// Identical routes keep the saved ID; "" and "direct" are the same route.
	same := csql
	same.GCPCloudSQL = &domain.GCPCloudSQLConfig{InstanceConnectionName: cfg.InstanceConnectionName}
	keep("gcp same", same, &csql)
	keep("ssm same", ssmP, &ssmP)
	keep("ssh same", sshP, &sshP)
	explicitDirect := direct
	explicitDirect.ConnectionMode = "direct"
	keep("direct same", explicitDirect, &direct)
}

func TestConnectionTestOfChangedRouteNeverClosesSavedProxy(t *testing.T) {
	for name, body := range map[string]string{
		"direct": `{"profile":{"id":"saved","name":"cs","driver":"mysql","host":"h","port":3306,"database":"app"}}`,
		"ssh":    `{"profile":{"id":"saved","name":"cs","driver":"mysql","connectionMode":"ssh","host":"h","port":3306,"database":"app","ssh":{"host":"b","port":22,"username":"u","identityFile":"/k"}}}`,
		"ssm":    `{"profile":{"id":"saved","name":"cs","driver":"mysql","connectionMode":"ssm","host":"h","port":3306,"database":"app","ssm":{"region":"ap-northeast-2","instanceId":"i-0123456789abcdef0"}}}`,
	} {
		t.Run(name, func(t *testing.T) {
			tunnels, handler, _ := cloudSQLTestRequest(t, "my-project:asia-northeast3:db-1")
			req := httptest.NewRequest(http.MethodPost, "/connection-test", strings.NewReader(body))
			req.Header.Set("X-App-Engine-Token", "token")
			handler.TestConnection().ServeHTTP(httptest.NewRecorder(), req)
			for _, id := range append(append([]string{}, tunnels.resolved...), tunnels.closed...) {
				if id == "saved" {
					t.Fatalf("saved profile id used: resolved=%v closed=%v", tunnels.resolved, tunnels.closed)
				}
			}
		})
	}
}
