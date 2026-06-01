package ports

import (
	"context"
	"testing"
)

func VerifySecretStoreContract(t *testing.T, store SecretStore) {
	ctx := context.Background()
	key := "test-key-123"
	secret := "super-secret-password-xyz"

	_ = store.Delete(ctx, key)

	t.Run("Set and Get", func(t *testing.T) {
		err := store.Set(ctx, key, secret)
		if err != nil {
			t.Fatalf("failed to set secret: %v", err)
		}

		got, err := store.Get(ctx, key)
		if err != nil {
			t.Fatalf("failed to get secret: %v", err)
		}

		if got != secret {
			t.Errorf("expected secret %s, got %s", secret, got)
		}
	})

	t.Run("Update secret", func(t *testing.T) {
		newSecret := "updated-secret-password-abc"
		err := store.Set(ctx, key, newSecret)
		if err != nil {
			t.Fatalf("failed to update secret: %v", err)
		}

		got, err := store.Get(ctx, key)
		if err != nil {
			t.Fatalf("failed to get updated secret: %v", err)
		}

		if got != newSecret {
			t.Errorf("expected updated secret %s, got %s", newSecret, got)
		}
	})

	t.Run("Delete secret", func(t *testing.T) {
		err := store.Delete(ctx, key)
		if err != nil {
			t.Fatalf("failed to delete secret: %v", err)
		}

		got, err := store.Get(ctx, key)
		if err == nil {
			t.Errorf("expected error getting deleted secret, got nil and value: %s", got)
		}
	})
}
