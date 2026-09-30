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
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/smlee/database-local-engine/engine/internal/agent"
	"github.com/smlee/database-local-engine/engine/internal/domain"
	"github.com/smlee/database-local-engine/engine/internal/ports"
)

const protocolVersion = "2024-11-05"

type Server struct {
	registry    *agent.Registry
	secrets     []string
	activity    ports.MCPActivityRepository
	workspaceID string
	profileID   string
}

func NewServer(reg *agent.Registry) *Server { return &Server{registry: reg} }

// SetActivity enables safe lifecycle/tool records for a profile's stdio
// session. Activity failures never break MCP responses.
func (s *Server) SetActivity(repo ports.MCPActivityRepository, workspaceID, profileID string) {
	s.activity = repo
	s.workspaceID = workspaceID
	s.profileID = profileID
}

func (s *Server) record(ctx context.Context, event, tool, status, message, queryText string, started time.Time) {
	if s.activity == nil {
		return
	}
	_ = s.activity.Append(ctx, &domain.MCPActivityEvent{
		ID:          uuid.NewString(),
		WorkspaceID: s.workspaceID,
		ProfileID:   s.profileID,
		Direction:   "inbound",
		Event:       event,
		Tool:        tool,
		Status:      status,
		Error:       domain.SafeMCPError(message),
		QueryText:   agent.Redact(queryText, s.secrets),
		DurationMs:  time.Since(started).Milliseconds(),
		CreatedAt:   time.Now().UTC(),
	})
}

// SetSecrets configures credential redaction applied to tool results before
// they leave the server. MCP tool results themselves are returned unchanged so
// clients can use row values and diagnostic output such as EXPLAIN plans.
func (s *Server) SetSecrets(secrets []string) {
	s.secrets = secrets
}

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

// Serve runs until EOF or cancellation, including while input is idle. The
// caller owns the reader and closes it when finished; stdin's blocking OS read
// cannot always be interrupted by File.Close, so reading must not block shutdown.
func (s *Server) Serve(ctx context.Context, in io.Reader, out io.Writer) (serveErr error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer func() {
		status, message := "success", ""
		if serveErr != nil {
			status, message = "error", serveErr.Error()
		}
		recordCtx, recordCancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
		defer recordCancel()
		s.record(recordCtx, "session_ended", "", status, message, "", time.Now())
	}()
	type inputMessage struct {
		line []byte
		err  error
		done bool
	}
	messages := make(chan inputMessage)
	go func() {
		sc := bufio.NewScanner(in)
		sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
		for sc.Scan() {
			// Scanner reuses its buffer; the handler owns this message's bytes.
			msg := inputMessage{line: append([]byte(nil), sc.Bytes()...)}
			select {
			case messages <- msg:
			case <-ctx.Done():
				return
			}
		}
		select {
		case messages <- inputMessage{done: true, err: sc.Err()}:
		case <-ctx.Done():
		}
	}()
	enc := json.NewEncoder(out)
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case msg := <-messages:
			if err := ctx.Err(); err != nil {
				return err
			}
			if msg.done {
				return msg.err
			}
			if len(msg.line) == 0 {
				continue
			}
			resp := s.Handle(ctx, msg.line)
			if resp == nil {
				continue
			} // notification: no reply
			if err := enc.Encode(resp); err != nil {
				return err
			}
		}
	}
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
		s.record(ctx, "session_started", "", "success", "", "", time.Now())
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
		started := time.Now()
		queries := make([]string, 0, 1)
		traceCtx := agent.WithQueryRecorder(ctx, func(query string) { queries = append(queries, query) })
		result, err := s.registry.Dispatch(traceCtx, p.Name, p.Arguments)
		queryText := strings.Join(queries, "\n\n")
		if err != nil {
			s.record(ctx, "tool_call", p.Name, "error", err.Error(), queryText, started)
			return reply(map[string]any{
				"content": []map[string]any{{"type": "text", "text": err.Error()}},
				"isError": true,
			})
		}
		s.record(ctx, "tool_call", p.Name, "success", "", queryText, started)
		b, _ := json.Marshal(result)
		text := agent.Redact(string(b), s.secrets)
		return reply(map[string]any{
			"content": []map[string]any{{"type": "text", "text": text}},
		})

	default:
		return &rpcResponse{Jsonrpc: "2.0", ID: req.ID, Error: &rpcError{Code: -32601, Message: "method not found: " + req.Method}}
	}
}
