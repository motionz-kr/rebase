package ports

import "context"

type SecretStore interface {
	Get(ctx context.Context, key string) (string, error)
	Set(ctx context.Context, key string, secret string) error
	Delete(ctx context.Context, key string) error
}
