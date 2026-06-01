package http

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthHandler(t *testing.T) {
	token := "secure-test-token"
	handler := NewHealthHandler(token)
	
	t.Run("valid token", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/health", nil)
		req.Header.Set("X-App-Engine-Token", token)
		rr := httptest.NewRecorder()
		
		handler.ServeHTTP(rr, req)
		
		if rr.Code != http.StatusOK {
			t.Errorf("expected status 200, got %d", rr.Code)
		}
	})
	
	t.Run("invalid token", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/health", nil)
		req.Header.Set("X-App-Engine-Token", "wrong-token")
		rr := httptest.NewRecorder()
		
		handler.ServeHTTP(rr, req)
		
		if rr.Code != http.StatusUnauthorized {
			t.Errorf("expected status 401, got %d", rr.Code)
		}
	})

	t.Run("missing token", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/health", nil)
		rr := httptest.NewRecorder()
		
		handler.ServeHTTP(rr, req)
		
		if rr.Code != http.StatusUnauthorized {
			t.Errorf("expected status 401, got %d", rr.Code)
		}
	})
}
