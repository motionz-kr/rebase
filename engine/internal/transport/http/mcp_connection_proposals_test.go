package http

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type fakeHTTPMCPConnectionProposals struct {
	items  []domain.MCPConnectionProposal
	action string
}

func (f *fakeHTTPMCPConnectionProposals) Propose(context.Context, domain.MCPConnectionProposal) (*domain.MCPConnectionProposal, error) {
	return nil, nil
}
func (f *fakeHTTPMCPConnectionProposals) List(context.Context, string, string, int) ([]domain.MCPConnectionProposal, error) {
	return f.items, nil
}
func (f *fakeHTTPMCPConnectionProposals) Resolve(_ context.Context, _, _, action string) error {
	f.action = action
	return nil
}

func TestMCPConnectionProposalHandlerRequiresTokenAndReturnsPendingItems(t *testing.T) {
	service := &fakeHTTPMCPConnectionProposals{items: []domain.MCPConnectionProposal{{
		ID: "proposal-1", WorkspaceID: "default", Operation: domain.MCPConnectionProposalCreate,
		CandidateID: domain.CandidateID("mysql", "127.0.0.1", 3306), Name: "test",
		Driver: "mysql", Host: "127.0.0.1", Port: 3306, TLSMode: "none", Source: "local", Status: domain.MCPConnectionProposalPending,
	}}}
	handler := NewMCPConnectionProposalHandler("token", service)

	unauthorized := httptest.NewRecorder()
	handler.Handle().ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/mcp/connection-proposals", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", unauthorized.Code)
	}

	request := httptest.NewRequest(http.MethodGet, "/mcp/connection-proposals?status=pending_approval", nil)
	request.Header.Set("X-App-Engine-Token", "token")
	response := httptest.NewRecorder()
	handler.Handle().ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "127.0.0.1") {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	for _, forbidden := range []string{"password", "secretRef", "mcpWriteMode", "connectionUri"} {
		if strings.Contains(response.Body.String(), forbidden) {
			t.Errorf("response contains forbidden field %q: %s", forbidden, response.Body.String())
		}
	}
}

func TestMCPConnectionProposalHandlerResolvesOnlyAuthenticatedUserActions(t *testing.T) {
	service := &fakeHTTPMCPConnectionProposals{}
	handler := NewMCPConnectionProposalHandler("token", service)
	request := httptest.NewRequest(http.MethodPost, "/mcp/connection-proposals", strings.NewReader(`{"id":"proposal-1","action":"reject"}`))
	request.Header.Set("X-App-Engine-Token", "token")
	response := httptest.NewRecorder()
	handler.Handle().ServeHTTP(response, request)
	if response.Code != http.StatusOK || service.action != "reject" {
		t.Fatalf("status = %d action = %q body = %s", response.Code, service.action, response.Body.String())
	}
}
