package mcpclient

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"testing"
)

// fakeServer answers JSON-RPC requests on r, writing responses to w.
func fakeServer(r io.Reader, w io.Writer) {
	sc := bufio.NewScanner(r)
	enc := json.NewEncoder(w)
	for sc.Scan() {
		var req map[string]any
		if json.Unmarshal(sc.Bytes(), &req) != nil {
			continue
		}
		id, hasID := req["id"]
		if !hasID {
			continue // notification
		}
		method, _ := req["method"].(string)
		resp := map[string]any{"jsonrpc": "2.0", "id": id}
		switch method {
		case "initialize":
			resp["result"] = map[string]any{"protocolVersion": "2024-11-05"}
		case "tools/list":
			resp["result"] = map[string]any{"tools": []map[string]any{
				{"name": "echo", "description": "Echo text", "inputSchema": map[string]any{"type": "object"}},
			}}
		case "tools/call":
			params, _ := req["params"].(map[string]any)
			args, _ := params["arguments"].(map[string]any)
			resp["result"] = map[string]any{"content": []map[string]any{
				{"type": "text", "text": "echo:" + asString(args["text"])},
			}}
		default:
			resp["error"] = map[string]any{"code": -32601, "message": "method not found"}
		}
		_ = enc.Encode(resp)
	}
}

func asString(v any) string { s, _ := v.(string); return s }

func newTestClient(t *testing.T) *Client {
	c2sR, c2sW := io.Pipe()
	s2cR, s2cW := io.Pipe()
	go fakeServer(c2sR, s2cW)
	c := newClient(c2sW, s2cR)
	if err := c.initialize(context.Background()); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	return c
}

func TestListTools(t *testing.T) {
	c := newTestClient(t)
	specs, err := c.ListTools(context.Background())
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(specs) != 1 || specs[0].Name != "echo" || specs[0].Description != "Echo text" {
		t.Fatalf("unexpected specs: %+v", specs)
	}
}

func TestCall(t *testing.T) {
	c := newTestClient(t)
	out, err := c.Call(context.Background(), "echo", map[string]any{"text": "hi"})
	if err != nil {
		t.Fatalf("Call: %v", err)
	}
	if out != "echo:hi" {
		t.Fatalf("got %v", out)
	}
}
