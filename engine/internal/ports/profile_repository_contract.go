package ports

import (
	"context"
	"testing"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

func VerifyProfileRepositoryContract(t *testing.T, repo ProfileRepository) {
	ctx := context.Background()

	p1 := &domain.ConnectionProfile{
		ID:        "p-1",
		Name:      "MySQL Dev",
		Driver:    "mysql",
		Host:      "localhost",
		Port:      3306,
		Database:  "devdb",
		Username:  "root",
		SecretRef: "secret-1",
		TLSMode:   "none",
		CreatedAt: time.Now().Round(time.Second),
		UpdatedAt: time.Now().Round(time.Second),
	}

	p2 := &domain.ConnectionProfile{
		ID:        "p-2",
		Name:      "Postgres Prod",
		Driver:    "postgres",
		Host:      "prod-host",
		Port:      5432,
		Database:  "proddb",
		Username:  "admin",
		SecretRef: "secret-2",
		TLSMode:   "require",
		CreatedAt: time.Now().Round(time.Second),
		UpdatedAt: time.Now().Round(time.Second),
	}

	t.Run("Create and GetByID", func(t *testing.T) {
		err := repo.Create(ctx, p1)
		if err != nil {
			t.Fatalf("failed to create profile: %v", err)
		}

		got, err := repo.GetByID(ctx, p1.ID)
		if err != nil {
			t.Fatalf("failed to get profile: %v", err)
		}

		if got.Name != p1.Name || got.Driver != p1.Driver || got.Host != p1.Host || got.Port != p1.Port || got.Database != p1.Database {
			t.Errorf("retrieved profile does not match created: %+v vs %+v", got, p1)
		}
	})

	t.Run("List profiles", func(t *testing.T) {
		err := repo.Create(ctx, p2)
		if err != nil {
			t.Fatalf("failed to create second profile: %v", err)
		}

		list, err := repo.List(ctx)
		if err != nil {
			t.Fatalf("failed to list profiles: %v", err)
		}

		if len(list) < 2 {
			t.Errorf("expected at least 2 profiles, got %d", len(list))
		}
	})

	t.Run("Update profile", func(t *testing.T) {
		p1.Name = "MySQL Dev Updated"
		p1.Port = 3307
		err := repo.Update(ctx, p1)
		if err != nil {
			t.Fatalf("failed to update profile: %v", err)
		}

		got, err := repo.GetByID(ctx, p1.ID)
		if err != nil {
			t.Fatalf("failed to get profile: %v", err)
		}

		if got.Name != "MySQL Dev Updated" || got.Port != 3307 {
			t.Errorf("profile updates were not persisted: %+v", got)
		}
	})

	t.Run("Delete profile", func(t *testing.T) {
		err := repo.Delete(ctx, p1.ID)
		if err != nil {
			t.Fatalf("failed to delete profile: %v", err)
		}

		got, err := repo.GetByID(ctx, p1.ID)
		if err == nil {
			t.Errorf("expected error getting deleted profile, got nil and: %+v", got)
		}
	})
}
