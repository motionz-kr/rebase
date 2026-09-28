package keychain

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strings"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type KeyringStore struct {
	service string
	mock    map[string]string
}

func NewKeyringStore(service string) *KeyringStore {
	return &KeyringStore{
		service: service,
		mock:    make(map[string]string),
	}
}

func (s *KeyringStore) Get(ctx context.Context, key string) (string, error) {
	if runtime.GOOS != "darwin" {
		val, exists := s.mock[key]
		if !exists {
			return "", ports.ErrSecretNotFound
		}
		return val, nil
	}

	cmd := exec.CommandContext(ctx, "security", "find-generic-password", "-s", s.service, "-a", key, "-w")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err != nil {
		if isItemNotFound(stderr.String()) {
			return "", fmt.Errorf("%w in keychain", ports.ErrSecretNotFound)
		}
		return "", errors.New("failed to retrieve secret: " + err.Error() + ", stderr: " + stderr.String())
	}

	return strings.TrimSpace(stdout.String()), nil
}

func (s *KeyringStore) Set(ctx context.Context, key string, secret string) error {
	if runtime.GOOS != "darwin" {
		s.mock[key] = secret
		return nil
	}

	cmd := exec.CommandContext(ctx, "security", "add-generic-password", "-s", s.service, "-a", key, "-w", secret, "-U")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err != nil {
		return errors.New("failed to set secret in keychain: " + err.Error() + ", stderr: " + stderr.String())
	}

	return nil
}

func (s *KeyringStore) Delete(ctx context.Context, key string) error {
	if runtime.GOOS != "darwin" {
		if _, exists := s.mock[key]; !exists {
			return ports.ErrSecretNotFound
		}
		delete(s.mock, key)
		return nil
	}

	cmd := exec.CommandContext(ctx, "security", "delete-generic-password", "-s", s.service, "-a", key)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err != nil {
		if isItemNotFound(stderr.String()) {
			return fmt.Errorf("%w in keychain", ports.ErrSecretNotFound)
		}
		return errors.New("failed to delete secret from keychain: " + err.Error() + ", stderr: " + stderr.String())
	}

	return nil
}

func isItemNotFound(stderr string) bool {
	return strings.Contains(stderr, "The specified item could not be found") || strings.Contains(stderr, "code 0xFFFF")
}
