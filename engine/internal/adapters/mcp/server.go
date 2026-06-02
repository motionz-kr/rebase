// Package mcp exposes the agent's DB tool registry as an MCP (Model Context
// Protocol) server over stdio, so a local AI CLI (e.g. claude --mcp-config) can
// call the same tools the Direct API path uses. Transport is newline-delimited
// JSON-RPC 2.0 (the MCP stdio convention).
package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"io"

	"github.com/smlee/database-local-engine/engine/internal/agent"
)

const protocolVersion = "2024-11-05"

type Server struct {
	registry *agent.Registry
}

func NewServer(reg *agent.Registry) *Server { return &Server{registry: reg} }

type rpcRequest struct {
	Jsonrpc string           `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id,omitempty"`
	Method  string           `json:"method"`
	Params  json.RawMessage  `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	Jsonrpc string           `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id,omitempty"`
	Result  any              `json:"result,omitempty"`
	Error   *rpcError        `json:"error,omitempty"`
}

// Serve runs the JSON-RPC loop until the input closes.
func (s *Server) Serve(ctx context.Context, in io.Reader, out io.Writer) error {
	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	enc := json.NewEncoder(out)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		resp := s.Handle(ctx, line)
		if resp == nil {
			continue // notification: no reply
		}
		if err := enc.Encode(resp); err != nil {
			return err
		}
	}
	return sc.Err()
}

// Handle processes one JSON-RPC message and returns the response, or nil for
// notifications (requests without an id). Exposed for unit testing.
func (s *Server) Handle(ctx context.Context, raw []byte) *rpcResponse {
	var req rpcRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		return &rpcResponse{Jsonrpc: "2.0", Error: &rpcError{Code: -32700, Message: "parse error"}}
	}
	if req.ID == nil {
		return nil // notification (e.g. notifications/initialized)
	}
	reply := func(result any) *rpcResponse {
		return &rpcResponse{Jsonrpc: "2.0", ID: req.ID, Result: result}
	}

	switch req.Method {
	case "initialize":
		return reply(map[string]any{
			"protocolVersion": protocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "rebase", "version": "0.1.0"},
		})

	case "tools/list":
		specs := s.registry.Specs()
		tools := make([]map[string]any, 0, len(specs))
		for _, sp := range specs {
			schema := sp.Schema
			if schema == nil {
				schema = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			tools = append(tools, map[string]any{
				"name":        sp.Name,
				"description": sp.Description,
				"inputSchema": schema,
			})
		}
		return reply(map[string]any{"tools": tools})

	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		_ = json.Unmarshal(req.Params, &p)
		result, err := s.registry.Dispatch(ctx, p.Name, p.Arguments)
		if err != nil {
			return reply(map[string]any{
				"content": []map[string]any{{"type": "text", "text": err.Error()}},
				"isError": true,
			})
		}
		b, _ := json.Marshal(result)
		return reply(map[string]any{
			"content": []map[string]any{{"type": "text", "text": string(b)}},
		})

	default:
		return &rpcResponse{Jsonrpc: "2.0", ID: req.ID, Error: &rpcError{Code: -32601, Message: "method not found: " + req.Method}}
	}
}
