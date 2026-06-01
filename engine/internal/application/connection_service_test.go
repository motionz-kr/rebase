package application

import (
	"context"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

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
