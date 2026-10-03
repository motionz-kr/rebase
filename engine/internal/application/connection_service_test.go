package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type getErrorSecretStore struct{ err error }

func (s getErrorSecretStore) Get(context.Context, string) (string, error) { return "", s.err }
func (s getErrorSecretStore) Set(context.Context, string, string) error   { return nil }
func (s getErrorSecretStore) Delete(context.Context, string) error        { return nil }

func TestAgentKeyRoundTripInSecretStore(t *testing.T) {
	ctx := context.Background()
	service := NewConnectionService(ports.NewFakeProfileRepository(), ports.NewFakeSecretStore())

	if service.HasAgentKey(ctx, "anthropic") {
		t.Fatal("no key should be stored initially")
	}
	if err := service.SetAgentKey(ctx, "anthropic", "sk-ant-secret"); err != nil {
		t.Fatalf("SetAgentKey: %v", err)
	}
	if !service.HasAgentKey(ctx, "anthropic") {
		t.Error("HasAgentKey should be true after Set")
	}
	got, err := service.GetAgentKey(ctx, "anthropic")
	if err != nil || got != "sk-ant-secret" {
		t.Errorf("GetAgentKey = %q, %v; want sk-ant-secret", got, err)
	}
	// Providers are namespaced independently.
	if service.HasAgentKey(ctx, "openai") {
		t.Error("openai key should be independent of anthropic")
	}
	if err := service.ClearAgentKey(ctx, "anthropic"); err != nil {
		t.Fatalf("ClearAgentKey: %v", err)
	}
	if service.HasAgentKey(ctx, "anthropic") {
		t.Error("HasAgentKey should be false after Clear")
	}
}

func TestSetAgentKeyRejectsEmptyProvider(t *testing.T) {
	ctx := context.Background()
	service := NewConnectionService(ports.NewFakeProfileRepository(), ports.NewFakeSecretStore())
	if err := service.SetAgentKey(ctx, "", "k"); err == nil {
		t.Error("expected an error for an empty provider")
	}
}

func TestConnectionService(t *testing.T) {
	ctx := context.Background()
	repo := ports.NewFakeProfileRepository()
	store := ports.NewFakeSecretStore()
	service := NewConnectionService(repo, store)

	p := &domain.ConnectionProfile{
		Name:     "Test MySQL",
		Driver:   "mysql",
		Host:     "127.0.0.1",
		Port:     3306,
		Database: "mydb",
		Username: "root",
		TLSMode:  "none",
	}
	password := "mypassword"

	err := service.CreateProfile(ctx, p, password)
	if err != nil {
		t.Fatalf("failed to create profile: %v", err)
	}

	if p.ID == "" {
		t.Error("expected profile ID to be generated")
	}
	if p.SecretRef == "" {
		t.Error("expected SecretRef to be generated")
	}

	savedPassword, err := store.Get(ctx, p.SecretRef)
	if err != nil {
		t.Fatalf("failed to fetch secret: %v", err)
	}
	if savedPassword != password {
		t.Errorf("expected password %s, got %s", password, savedPassword)
	}

	gotProfile, gotPassword, err := service.GetProfile(ctx, p.ID)
	if err != nil {
		t.Fatalf("failed to get profile: %v", err)
	}
	if gotProfile.Name != p.Name || gotPassword != password {
		t.Errorf("got invalid profile/password: %+v, %s", gotProfile, gotPassword)
	}

	p.Name = "Test MySQL Updated"
	err = service.UpdateProfile(ctx, p, "newpassword")
	if err != nil {
		t.Fatalf("failed to update profile: %v", err)
	}

	_, gotPassword, err = service.GetProfile(ctx, p.ID)
	if err != nil {
		t.Fatalf("failed to get updated profile: %v", err)
	}
	if gotPassword != "newpassword" {
		t.Errorf("expected updated password 'newpassword', got '%s'", gotPassword)
	}

	err = service.DeleteProfile(ctx, p.ID)
	if err != nil {
		t.Fatalf("failed to delete profile: %v", err)
	}

	_, _, err = service.GetProfile(ctx, p.ID)
	if err == nil {
		t.Error("expected error getting deleted profile, got nil")
	}

	_, err = store.Get(ctx, p.SecretRef)
	if err == nil {
		t.Error("expected secret to be deleted from SecretStore, got nil error")
	}
}

func TestConnectionServiceUpdateProfilePreservesSecretRefWhenPasswordIsOmitted(t *testing.T) {
	ctx := context.Background()
	repo := ports.NewFakeProfileRepository()
	store := ports.NewFakeSecretStore()
	service := NewConnectionService(repo, store)

	p := &domain.ConnectionProfile{
		Name:     "Keeps Credentials",
		Driver:   "mysql",
		Host:     "127.0.0.1",
		Port:     3306,
		Database: "mydb",
		Username: "root",
		TLSMode:  "none",
	}
	const password = "still-secret"
	if err := service.CreateProfile(ctx, p, password); err != nil {
		t.Fatalf("CreateProfile: %v", err)
	}

	// The renderer sends an edited profile without secretRef because the field
	// is intentionally not exposed in the form model.
	edited := *p
	edited.Name = "Renamed Without Password"
	edited.SecretRef = ""
	if err := service.UpdateProfile(ctx, &edited, ""); err != nil {
		t.Fatalf("UpdateProfile: %v", err)
	}

	got, gotPassword, err := service.GetProfile(ctx, p.ID)
	if err != nil {
		t.Fatalf("GetProfile: %v", err)
	}
	if got.SecretRef != p.SecretRef {
		t.Fatalf("secretRef = %q, want %q", got.SecretRef, p.SecretRef)
	}
	if gotPassword != password {
		t.Errorf("password = %q, want %q", gotPassword, password)
	}
}

func TestConnectionServiceUpdateProfileRejectsStaleRevision(t *testing.T) {
	ctx := context.Background()
	repo := ports.NewFakeProfileRepository()
	service := NewConnectionService(repo, ports.NewFakeSecretStore())
	profile := &domain.ConnectionProfile{
		Name: "Original", Driver: "mysql", Host: "127.0.0.1", Port: 3306,
		Database: "testdb", Username: "tester", TLSMode: "none",
	}
	if err := service.CreateProfile(ctx, profile, ""); err != nil {
		t.Fatalf("CreateProfile: %v", err)
	}
	stale := *profile
	latest, err := repo.GetByID(ctx, profile.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	latest.Name = "Changed elsewhere"
	latest.UpdatedAt = latest.UpdatedAt.Add(time.Second)
	if err := repo.Update(ctx, latest); err != nil {
		t.Fatalf("simulate concurrent update: %v", err)
	}
	stale.Name = "Overwrite from stale form"
	if err := service.UpdateProfile(ctx, &stale, ""); err == nil {
		t.Fatal("UpdateProfile should reject an outdated profile revision")
	}
	got, err := repo.GetByID(ctx, profile.ID)
	if err != nil {
		t.Fatalf("GetByID after stale update: %v", err)
	}
	if got.Name != "Changed elsewhere" {
		t.Fatalf("stale update overwrote latest profile name: %q", got.Name)
	}
}

func TestConnectionServiceGetProfileRecoversLegacyEmptySecretRef(t *testing.T) {
	ctx := context.Background()
	repo := ports.NewFakeProfileRepository()
	store := ports.NewFakeSecretStore()
	service := NewConnectionService(repo, store)
	p := &domain.ConnectionProfile{
		Name: "Legacy profile", Driver: "mysql", Host: "127.0.0.1",
		Port: 3306, Database: "mydb", Username: "root", TLSMode: "none",
	}
	const password = "legacy-password"
	if err := service.CreateProfile(ctx, p, password); err != nil {
		t.Fatalf("CreateProfile: %v", err)
	}

	// Before the credential-preservation fix, editing a profile with a blank
	// password could persist an empty reference while leaving this secret behind.
	legacy, err := repo.GetByID(ctx, p.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	legacy.SecretRef = ""
	if err := repo.Update(ctx, legacy); err != nil {
		t.Fatalf("simulate legacy profile: %v", err)
	}

	got, gotPassword, err := service.GetProfile(ctx, p.ID)
	if err != nil {
		t.Fatalf("GetProfile: %v", err)
	}
	wantRef := "secret-" + p.ID
	if got.SecretRef != wantRef {
		t.Errorf("recovered secretRef = %q, want %q", got.SecretRef, wantRef)
	}
	if gotPassword != password {
		t.Errorf("password = %q, want legacy password", gotPassword)
	}

	persisted, err := repo.GetByID(ctx, p.ID)
	if err != nil {
		t.Fatalf("GetByID after recovery: %v", err)
	}
	if persisted.SecretRef != wantRef {
		t.Errorf("persisted secretRef = %q, want %q", persisted.SecretRef, wantRef)
	}
}

func TestConnectionServiceUpdateProfileRepairsLegacyEmptySecretRef(t *testing.T) {
	ctx := context.Background()
	repo := ports.NewFakeProfileRepository()
	store := ports.NewFakeSecretStore()
	service := NewConnectionService(repo, store)
	p := &domain.ConnectionProfile{
		Name: "Legacy profile", Driver: "mysql", Host: "127.0.0.1",
		Port: 3306, Database: "mydb", Username: "root", TLSMode: "none",
	}
	if err := service.CreateProfile(ctx, p, "old-password"); err != nil {
		t.Fatalf("CreateProfile: %v", err)
	}

	legacy, err := repo.GetByID(ctx, p.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	legacy.SecretRef = ""
	if err := repo.Update(ctx, legacy); err != nil {
		t.Fatalf("simulate legacy profile: %v", err)
	}

	edited := *p
	edited.Name = "Repaired profile"
	edited.SecretRef = ""
	if err := service.UpdateProfile(ctx, &edited, ""); err != nil {
		t.Fatalf("UpdateProfile: %v", err)
	}

	wantRef := "secret-" + p.ID
	if edited.SecretRef != wantRef {
		t.Errorf("updated secretRef = %q, want %q", edited.SecretRef, wantRef)
	}
	gotPassword, err := store.Get(ctx, wantRef)
	if err != nil || gotPassword != "old-password" {
		t.Errorf("password after update = %q, %v; want existing password", gotPassword, err)
	}
}

func TestConnectionServiceGetProfileReturnsKeychainReadErrors(t *testing.T) {
	ctx := context.Background()
	repo := ports.NewFakeProfileRepository()
	profile := &domain.ConnectionProfile{
		ID: "keychain-error", Name: "Profile", Driver: "mysql", Host: "127.0.0.1",
		Port: 3306, Database: "mydb", Username: "root", SecretRef: "secret-keychain-error", TLSMode: "none",
	}
	if err := repo.Create(ctx, profile); err != nil {
		t.Fatalf("Create: %v", err)
	}
	keychainErr := errors.New("keychain access denied")
	service := NewConnectionService(repo, getErrorSecretStore{err: keychainErr})

	_, _, err := service.GetProfile(ctx, profile.ID)
	if !errors.Is(err, keychainErr) {
		t.Fatalf("GetProfile error = %v, want wrapped keychain error", err)
	}
}

func TestConnectionServiceGetProfileAllowsMissingSecretForPasswordlessConnection(t *testing.T) {
	ctx := context.Background()
	repo := ports.NewFakeProfileRepository()
	store := ports.NewFakeSecretStore()
	service := NewConnectionService(repo, store)
	p := &domain.ConnectionProfile{
		Name: "Passwordless profile", Driver: "mysql", Host: "127.0.0.1",
		Port: 3306, Database: "mydb", Username: "root", TLSMode: "none",
	}
	if err := service.CreateProfile(ctx, p, ""); err != nil {
		t.Fatalf("CreateProfile: %v", err)
	}
	if err := store.Delete(ctx, p.SecretRef); err != nil {
		t.Fatalf("Delete secret: %v", err)
	}

	gotProfile, gotPassword, err := service.GetProfile(ctx, p.ID)
	if err != nil {
		t.Fatalf("GetProfile: %v", err)
	}
	if gotProfile == nil || gotPassword != "" {
		t.Fatalf("GetProfile = (%+v, %q); want profile with empty password", gotProfile, gotPassword)
	}
}

func TestSetMCPConnectionSettingsUsesFullResultMode(t *testing.T) {
	ctx := context.Background()
	repo := ports.NewFakeProfileRepository()
	service := NewConnectionService(repo, ports.NewFakeSecretStore())
	p := &domain.ConnectionProfile{Name: "MCP", Driver: "sqlite", Database: "db.sqlite"}
	if err := service.CreateProfile(ctx, p, ""); err != nil {
		t.Fatalf("CreateProfile: %v", err)
	}

	if err := service.SetMCPConnectionSettings(ctx, p.ID, true, "metadata", domain.MCPWriteModeApproval); err != nil {
		t.Fatalf("SetMCPConnectionSettings: %v", err)
	}
	got, err := service.ListProfiles(ctx)
	if err != nil {
		t.Fatalf("ListProfiles: %v", err)
	}
	if len(got) != 1 || !got[0].McpEnabled || got[0].McpDataExposure != "unrestricted" {
		t.Fatalf("MCP settings = %+v, want enabled with unrestricted results", got)
	}
	if got[0].McpWriteMode != domain.MCPWriteModeApproval {
		t.Fatalf("MCP write mode = %q", got[0].McpWriteMode)
	}
}

func TestSetMCPConnectionSettingsAcceptsFullAccess(t *testing.T) {
	ctx := context.Background()
	repo := ports.NewFakeProfileRepository()
	service := NewConnectionService(repo, ports.NewFakeSecretStore())
	p := &domain.ConnectionProfile{Name: "MCP full access", Driver: "sqlite", Database: "db.sqlite"}
	if err := service.CreateProfile(ctx, p, ""); err != nil {
		t.Fatalf("CreateProfile: %v", err)
	}

	if err := service.SetMCPConnectionSettings(ctx, p.ID, true, "unrestricted", domain.MCPWriteModeFullAccess); err != nil {
		t.Fatalf("SetMCPConnectionSettings: %v", err)
	}
	got, err := service.ListProfiles(ctx)
	if err != nil {
		t.Fatalf("ListProfiles: %v", err)
	}
	if len(got) != 1 || got[0].McpWriteMode != domain.MCPWriteModeFullAccess {
		t.Fatalf("MCP write mode = %+v, want full access", got)
	}
}
