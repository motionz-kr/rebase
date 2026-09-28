package keychain

import (
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

func TestIsItemNotFound(t *testing.T) {
	tests := []struct {
		name   string
		stderr string
		want   bool
	}{
		{name: "missing item text", stderr: "security: The specified item could not be found in the keychain.", want: true},
		{name: "missing item status", stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain. (code 0xFFFF)", want: true},
		{name: "access denied", stderr: "security: User interaction is not allowed.", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isItemNotFound(tt.stderr); got != tt.want {
				t.Fatalf("isItemNotFound(%q) = %v, want %v", tt.stderr, got, tt.want)
			}
		})
	}
}

func TestKeyringStore_Contract(t *testing.T) {
	store := NewKeyringStore("AntigravityDBDesktopTest")
	ports.VerifySecretStoreContract(t, store)
}
