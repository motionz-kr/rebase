package ports

import (
	"context"
	"errors"
)

// ErrSecretNotFound distinguishes an absent credential from a keychain access
// failure. Callers may allow passwordless connections when the item is absent,
// but must not silently treat keychain failures as an empty password.
var ErrSecretNotFound = errors.New("secret not found")

type SecretStore interface {
	Get(ctx context.Context, key string) (string, error)
	Set(ctx context.Context, key string, secret string) error
	Delete(ctx context.Context, key string) error
}
