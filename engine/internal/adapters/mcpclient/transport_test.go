package mcpclient

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func newHTTPEcho(t *testing.T, sse bool) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Test") != "1" {
			t.Errorf("missing custom header X-Test")
		}
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		id := req["id"]
		method, _ := req["method"].(string)
		w.Header().Set("Mcp-Session-Id", "sess-1")
		writeJSON := func(result any) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
		}
		switch method {
		case "initialize":
			writeJSON(map[string]any{"protocolVersion": "2024-11-05"})
		case "tools/list":
			writeJSON(map[string]any{"tools": []map[string]any{{"name": "echo", "description": "Echo"}}})
		case "tools/call":
			result := map[string]any{"content": []map[string]any{{"type": "text", "text": "ok"}}}
			if sse {
				w.Header().Set("Content-Type", "text/event-stream")
				b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
				fmt.Fprintf(w, "event: message\ndata: %s\n\n", b)
			} else {
				writeJSON(result)
			}
		default:
			w.WriteHeader(http.StatusAccepted)
		}
	}))
}

func TestHTTPTransport_JSON(t *testing.T) {
	srv := newHTTPEcho(t, false)
	defer srv.Close()
	c, err := DialHTTP(context.Background(), srv.URL, map[string]string{"X-Test": "1"})
	if err != nil {
		t.Fatalf("DialHTTP: %v", err)
	}
	defer c.Close()
	specs, err := c.ListTools(context.Background())
	if err != nil || len(specs) != 1 || specs[0].Name != "echo" {
		t.Fatalf("ListTools: %v %+v", err, specs)
	}
	out, err := c.Call(context.Background(), "echo", map[string]any{"x": 1})
	if err != nil || out != "ok" {
		t.Fatalf("Call: %v %v", out, err)
	}
}

func TestHTTPTransport_SSE(t *testing.T) {
	srv := newHTTPEcho(t, true)
	defer srv.Close()
	c, err := DialHTTP(context.Background(), srv.URL, map[string]string{"X-Test": "1"})
	if err != nil {
		t.Fatalf("DialHTTP: %v", err)
	}
	defer c.Close()
	out, err := c.Call(context.Background(), "echo", nil)
	if err != nil || out != "ok" {
		t.Fatalf("SSE Call: %v %v", out, err)
	}
}

func TestHTTPTransport_HTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusUnauthorized)
	}))
	defer srv.Close()
	_, err := DialHTTP(context.Background(), srv.URL, map[string]string{"X-Test": "1"})
	if err == nil {
		t.Fatal("expected initialize to fail on 401")
	}
}
