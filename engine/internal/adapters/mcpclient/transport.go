package mcpclient

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"sync"
)

type transport interface {
	request(ctx context.Context, method string, params any) (json.RawMessage, error)
	notify(ctx context.Context, method string, params any) error
	Close() error
}

// --- stdio (moved verbatim from the old Client) ---

type stdioTransport struct {
	mu  sync.Mutex
	w   io.Writer
	r   *bufio.Reader
	cmd *exec.Cmd // nil in tests
	id  int
}

func newStdio(w io.Writer, r io.Reader) *stdioTransport {
	return &stdioTransport{w: w, r: bufio.NewReader(r)}
}

func (t *stdioTransport) notify(_ context.Context, method string, params any) error {
	b, _ := json.Marshal(rpcReq{Jsonrpc: "2.0", Method: method, Params: params})
	_, err := t.w.Write(append(b, '\n'))
	return err
}

func (t *stdioTransport) request(_ context.Context, method string, params any) (json.RawMessage, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.id++
	id := t.id
	b, _ := json.Marshal(rpcReq{Jsonrpc: "2.0", ID: &id, Method: method, Params: params})
	if _, err := t.w.Write(append(b, '\n')); err != nil {
		return nil, err
	}
	for {
		line, err := t.r.ReadBytes('\n')
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

func (t *stdioTransport) Close() error {
	if wc, ok := t.w.(io.Closer); ok {
		_ = wc.Close()
	}
	if t.cmd != nil && t.cmd.Process != nil {
		_ = t.cmd.Process.Kill()
		_ = t.cmd.Wait()
	}
	return nil
}

// --- http (Streamable HTTP, MCP 2025-03) ---

type httpTransport struct {
	url     string
	headers map[string]string
	client  *http.Client
	mu      sync.Mutex
	id      int
	session string
}

func newHTTP(url string, headers map[string]string) *httpTransport {
	return &httpTransport{url: url, headers: headers, client: &http.Client{}}
}

func (t *httpTransport) post(ctx context.Context, body []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	for k, v := range t.headers {
		req.Header.Set(k, v)
	}
	t.mu.Lock()
	sid := t.session
	t.mu.Unlock()
	if sid != "" {
		req.Header.Set("Mcp-Session-Id", sid)
	}
	return t.client.Do(req)
}

func (t *httpTransport) notify(ctx context.Context, method string, params any) error {
	b, _ := json.Marshal(rpcReq{Jsonrpc: "2.0", Method: method, Params: params})
	resp, err := t.post(ctx, b)
	if err != nil {
		return err
	}
	_ = resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("http %d", resp.StatusCode)
	}
	return nil
}

func (t *httpTransport) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	t.mu.Lock()
	t.id++
	id := t.id
	t.mu.Unlock()
	b, _ := json.Marshal(rpcReq{Jsonrpc: "2.0", ID: &id, Method: method, Params: params})
	resp, err := t.post(ctx, b)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		t.mu.Lock()
		t.session = sid
		t.mu.Unlock()
	}
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("http %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		return readSSEResponse(resp.Body, id)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	return parseRPCResult(body, id)
}

func (t *httpTransport) Close() error { return nil }

// readSSEResponse reads SSE event blocks (blank-line separated), joins each
// block's data: lines with "\n", and returns the first JSON-RPC message whose
// id matches. Non-matching messages (server notifications) are skipped.
func readSSEResponse(body io.Reader, id int) (json.RawMessage, error) {
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	var dataLines []string
	flush := func() (json.RawMessage, bool, error) {
		if len(dataLines) == 0 {
			return nil, false, nil
		}
		raw := []byte(strings.Join(dataLines, "\n"))
		dataLines = dataLines[:0]
		var resp rpcResp
		if json.Unmarshal(raw, &resp) != nil || resp.ID == nil || *resp.ID != id {
			return nil, false, nil
		}
		if resp.Error != nil {
			return nil, true, fmt.Errorf("rpc error %d: %s", resp.Error.Code, resp.Error.Message)
		}
		return resp.Result, true, nil
	}
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			if res, done, err := flush(); done || err != nil {
				return res, err
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			dataLines = append(dataLines, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if res, done, err := flush(); done || err != nil {
		return res, err
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("event stream ended without response for id %d", id)
}

func parseRPCResult(body []byte, id int) (json.RawMessage, error) {
	var resp rpcResp
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, err
	}
	if resp.ID == nil || *resp.ID != id {
		return nil, fmt.Errorf("response id mismatch")
	}
	if resp.Error != nil {
		return nil, fmt.Errorf("rpc error %d: %s", resp.Error.Code, resp.Error.Message)
	}
	return resp.Result, nil
}
