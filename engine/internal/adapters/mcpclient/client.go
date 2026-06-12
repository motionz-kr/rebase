// Package mcpclient is an outbound MCP client that speaks JSON-RPC 2.0 to an
// external server over a pluggable transport (stdio or Streamable HTTP):
// initialize, tools/list, tools/call.
package mcpclient

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type Client struct {
	t transport
}

// newClient wraps a stdio transport over the given pipes (used by tests).
func newClient(w io.Writer, r io.Reader) *Client {
	return &Client{t: newStdio(w, r)}
}

// DialStdio spawns the server process, performs the initialize handshake, and
// returns a ready client. env is merged onto the current environment.
func DialStdio(ctx context.Context, command string, args []string, env map[string]string) (*Client, error) {
	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("spawn %q: %w", command, err)
	}
	st := newStdio(stdin, stdout)
	st.cmd = cmd
	c := &Client{t: st}
	if err := c.initialize(ctx); err != nil {
		_ = c.Close()
		return nil, err
	}
	return c, nil
}

// DialHTTP connects to a Streamable HTTP MCP server at url with the given
// request headers (e.g. Authorization), performing the initialize handshake.
func DialHTTP(ctx context.Context, url string, headers map[string]string) (*Client, error) {
	c := &Client{t: newHTTP(url, headers)}
	if err := c.initialize(ctx); err != nil {
		_ = c.Close()
		return nil, err
	}
	return c, nil
}

type rpcReq struct {
	Jsonrpc string `json:"jsonrpc"`
	ID      *int   `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type rpcResp struct {
	ID     *int            `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (c *Client) initialize(ctx context.Context) error {
	_, err := c.t.request(ctx, "initialize", map[string]any{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "rebase", "version": "0.1.0"},
	})
	if err != nil {
		return err
	}
	return c.t.notify(ctx, "notifications/initialized", map[string]any{})
}

// ListTools returns the server's tool catalog mapped to ports.ToolSpec.
func (c *Client) ListTools(ctx context.Context) ([]ports.ToolSpec, error) {
	raw, err := c.t.request(ctx, "tools/list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var out struct {
		Tools []struct {
			Name        string         `json:"name"`
			Description string         `json:"description"`
			InputSchema map[string]any `json:"inputSchema"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	specs := make([]ports.ToolSpec, 0, len(out.Tools))
	for _, t := range out.Tools {
		specs = append(specs, ports.ToolSpec{Name: t.Name, Description: t.Description, Schema: t.InputSchema})
	}
	return specs, nil
}

// Call invokes a tool. MCP content text parts are concatenated; JSON text is
// decoded, otherwise returned as a string. isError surfaces as a Go error.
func (c *Client) Call(ctx context.Context, name string, args map[string]any) (any, error) {
	raw, err := c.t.request(ctx, "tools/call", map[string]any{"name": name, "arguments": args})
	if err != nil {
		return nil, err
	}
	var out struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		IsError bool `json:"isError"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	text := ""
	for _, p := range out.Content {
		text += p.Text
	}
	if out.IsError {
		return nil, fmt.Errorf("%s", text)
	}
	var decoded any
	if json.Unmarshal([]byte(text), &decoded) == nil {
		return decoded, nil
	}
	return text, nil
}

// Close releases the transport (terminates a stdio process; no-op for HTTP).
func (c *Client) Close() error { return c.t.Close() }
