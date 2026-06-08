// Package mcpclient is an outbound MCP client over stdio: it spawns an external
// MCP server process and speaks newline-delimited JSON-RPC 2.0 (initialize,
// tools/list, tools/call). Requests are serialized (one in flight at a time).
package mcpclient

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

type Client struct {
	mu  sync.Mutex
	w   io.Writer
	r   *bufio.Reader
	cmd *exec.Cmd // nil in tests
	id  int
}

func newClient(w io.Writer, r io.Reader) *Client {
	br := bufio.NewReader(r)
	return &Client{w: w, r: br}
}

// Dial spawns the server process, performs the initialize handshake, and
// returns a ready client. env is merged onto the current environment.
func Dial(ctx context.Context, command string, args []string, env map[string]string) (*Client, error) {
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
	c := newClient(stdin, stdout)
	c.cmd = cmd
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

// notify writes a JSON-RPC notification (no id, no reply expected).
func (c *Client) notify(method string, params any) error {
	b, _ := json.Marshal(rpcReq{Jsonrpc: "2.0", Method: method, Params: params})
	_, err := c.w.Write(append(b, '\n'))
	return err
}

// request sends a request and reads responses until the matching id arrives,
// skipping notifications/logs the server may interleave.
func (c *Client) request(method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.id++
	id := c.id
	b, _ := json.Marshal(rpcReq{Jsonrpc: "2.0", ID: &id, Method: method, Params: params})
	if _, err := c.w.Write(append(b, '\n')); err != nil {
		return nil, err
	}
	for {
		line, err := c.r.ReadBytes('\n')
		if err != nil {
			return nil, err
		}
		var resp rpcResp
		if json.Unmarshal(line, &resp) != nil || resp.ID == nil {
			continue
		}
		if *resp.ID != id {
			continue
		}
		if resp.Error != nil {
			return nil, fmt.Errorf("rpc error %d: %s", resp.Error.Code, resp.Error.Message)
		}
		return resp.Result, nil
	}
}

func (c *Client) initialize(ctx context.Context) error {
	_ = ctx
	_, err := c.request("initialize", map[string]any{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "rebase", "version": "0.1.0"},
	})
	if err != nil {
		return err
	}
	return c.notify("notifications/initialized", map[string]any{})
}

// ListTools returns the server's tool catalog mapped to ports.ToolSpec.
func (c *Client) ListTools(ctx context.Context) ([]ports.ToolSpec, error) {
	_ = ctx
	raw, err := c.request("tools/list", map[string]any{})
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

// Call invokes a tool and returns its result. MCP content text parts are
// concatenated; if the text parses as JSON it is returned as the decoded value,
// otherwise as a string. isError surfaces as a Go error.
func (c *Client) Call(ctx context.Context, name string, args map[string]any) (any, error) {
	_ = ctx
	raw, err := c.request("tools/call", map[string]any{"name": name, "arguments": args})
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

// Close terminates the server process (best-effort).
func (c *Client) Close() error {
	if wc, ok := c.w.(io.Closer); ok {
		_ = wc.Close()
	}
	if c.cmd != nil && c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
		_ = c.cmd.Wait()
	}
	return nil
}
