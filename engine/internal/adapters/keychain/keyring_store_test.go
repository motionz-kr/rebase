package keychain

import (
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

func TestKeyringStore_Contract(t *testing.T) {
	store := NewKeyringStore("AntigravityDBDesktopTest")
	ports.VerifySecretStoreContract(t, store)
}
