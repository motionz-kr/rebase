package http

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/application"
)

func TestAgentComplete_StubStreamsTextNoTools(t *testing.T) {
	h := NewAgentHandler("tok", &application.ConnectionService{})
	body, _ := json.Marshal(map[string]any{
		"provider": "stub",
		"system":   "You write summaries.",
		"messages": []map[string]string{{"role": "user", "text": "hello there"}},
	})
	req := httptest.NewRequest(http.MethodPost, "/agent/complete", bytes.NewReader(body))
	req.Header.Set("X-App-Engine-Token", "tok")
	w := httptest.NewRecorder()
	h.Complete().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: %d body=%s", w.Code, w.Body.String())
	}
	out := w.Body.String()
	if !strings.Contains(out, `"kind":"text"`) || !strings.Contains(out, `"kind":"done"`) {
		t.Fatalf("expected text+done NDJSON, got: %s", out)
	}
	if strings.Contains(out, `"kind":"tool_call"`) {
		t.Fatalf("complete must not run tools: %s", out)
	}
}

func TestAgentComplete_RejectsBadAuth(t *testing.T) {
	h := NewAgentHandler("tok", &application.ConnectionService{})
	req := httptest.NewRequest(http.MethodPost, "/agent/complete", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	h.Complete().ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", w.Code)
	}
}
