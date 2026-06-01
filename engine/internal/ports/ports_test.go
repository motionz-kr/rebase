package ports

import (
	"testing"
)

func TestFakeProfileRepository_Contract(t *testing.T) {
	repo := NewFakeProfileRepository()
	VerifyProfileRepositoryContract(t, repo)
}

func TestFakeSecretStore_Contract(t *testing.T) {
	store := NewFakeSecretStore()
	VerifySecretStoreContract(t, store)
}

func TestFakeWorkspaceRepository_Contract(t *testing.T) {
	repo := NewFakeWorkspaceRepository()
	VerifyWorkspaceRepositoryContract(t, repo)
}

