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
