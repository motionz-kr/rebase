package http

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/application"
	"github.com/smlee/database-local-engine/engine/internal/domain"
)

type testDatabaseDiscovery struct {
	result domain.DatabaseDiscoveryResult
	err    error
}

func (d testDatabaseDiscovery) Discover(context.Context) (domain.DatabaseDiscoveryResult, error) {
	return d.result, d.err
}

func TestDatabaseDiscoveryHandlerRequiresEngineToken(t *testing.T) {
	service := application.NewDatabaseDiscoveryService(testDatabaseDiscovery{})
	handler := NewDatabaseDiscoveryHandler("token", service)
	response := httptest.NewRecorder()
	handler.Discover().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/database-discovery", nil))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusUnauthorized)
	}
}

func TestDatabaseDiscoveryHandlerReturnsOnlyValidatedCandidates(t *testing.T) {
	candidate := domain.DiscoveredDatabase{ID: domain.CandidateID("mysql", "127.0.0.1", 3306), Driver: "mysql", Host: "127.0.0.1", Port: 3306, Source: "local"}
	service := application.NewDatabaseDiscoveryService(testDatabaseDiscovery{result: domain.DatabaseDiscoveryResult{Candidates: []domain.DiscoveredDatabase{candidate}}})
	handler := NewDatabaseDiscoveryHandler("token", service)
	request := httptest.NewRequest(http.MethodPost, "/database-discovery", nil)
	request.Header.Set("X-App-Engine-Token", "token")
	response := httptest.NewRecorder()
	handler.Discover().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if got := response.Body.String(); !strings.Contains(got, "127.0.0.1") || strings.Contains(got, "password") || strings.Contains(got, "secretRef") {
		t.Fatalf("unexpected discovery response: %s", got)
	}
}

func TestDatabaseDiscoveryHandlerReturnsErrorOnFailure(t *testing.T) {
	service := application.NewDatabaseDiscoveryService(testDatabaseDiscovery{err: errors.New("discovery unavailable")})
	handler := NewDatabaseDiscoveryHandler("token", service)
	request := httptest.NewRequest(http.MethodPost, "/database-discovery", nil)
	request.Header.Set("X-App-Engine-Token", "token")
	response := httptest.NewRecorder()
	handler.Discover().ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusInternalServerError)
	}
}
