package domain

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestMCPConnectionProposalValidate(t *testing.T) {
	candidateID := CandidateID("mysql", "127.0.0.1", 3307)
	base := MCPConnectionProposal{
		ID: "proposal-1", WorkspaceID: "default", Operation: MCPConnectionProposalCreate,
		ResultProfileID: "profile-result-1",
		CandidateID:     candidateID, Name: "Local test", Driver: "mysql", Host: "127.0.0.1",
		Port: 3307, TLSMode: "none", Source: "docker", SourceName: "test-mysql", Status: MCPConnectionProposalPending,
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := base.Validate(); err != nil {
		t.Fatalf("valid create proposal: %v", err)
	}

	bad := base
	bad.Operation = MCPConnectionProposalUpdate
	if err := bad.Validate(); err == nil {
		t.Fatal("update proposal without target profile should fail")
	}

	bad = base
	bad.Host = "db.example.com"
	if err := bad.Validate(); err == nil {
		t.Fatal("proposal with non-loopback host should fail")
	}

	bad = base
	bad.Driver = "postgres"
	if err := bad.Validate(); err == nil {
		t.Fatal("proposal whose endpoint does not match candidate id should fail")
	}

	bad = base
	bad.ResultProfileID = ""
	if err := bad.Validate(); err == nil {
		t.Fatal("create proposal without reserved profile ID should fail")
	}
}

func TestMCPConnectionProposalJSONContainsNoCredentialFields(t *testing.T) {
	proposal := MCPConnectionProposal{
		ID: "proposal-1", WorkspaceID: "default", Operation: MCPConnectionProposalCreate,
		ResultProfileID: "profile-result-1",
		CandidateID:     CandidateID("postgres", "127.0.0.1", 5432), Name: "Local PG",
		Driver: "postgres", Host: "127.0.0.1", Port: 5432, Source: "local",
		Status: MCPConnectionProposalPending,
	}
	encoded, err := json.Marshal(proposal)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"password", "secretRef", "connectionUri", "mcpWriteMode", "mcpEnabled"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Errorf("proposal JSON contains forbidden field %q: %s", forbidden, encoded)
		}
	}
}
