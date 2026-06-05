package llm

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// Codex / ChatGPT OAuth (ChatGPT Plus/Pro subscription) constants. Mirrors the
// codex CLI / opencode plugins: browser OAuth with a fixed loopback redirect,
// then calls the ChatGPT Codex backend (Responses API) with the token — no API
// key. See docs/superpowers/specs/2026-06-05-codex-oauth-login-design.md.
const (
	codexOAuthClientID = "app_EMoamEEZ73f0CkXaXp7hrann"
	codexAuthorizeEP   = "https://auth.openai.com/oauth/authorize"
	codexTokenEP       = "https://auth.openai.com/oauth/token"
	codexRedirectURI   = "http://localhost:1455/auth/callback"
	codexLoopbackAddr  = "127.0.0.1:1455"
	codexScope         = "openid profile email offline_access"
	codexResponsesURL  = "https://chatgpt.com/backend-api/codex/responses"
)

// ---- pure helpers (unit-tested) ----

// decodeJWTPayload base64url-decodes a JWT's middle (claims) segment.
func decodeJWTPayload(token string) (map[string]any, error) {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil, fmt.Errorf("not a JWT")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, err
	}
	var claims map[string]any
	if err := json.Unmarshal(raw, &claims); err != nil {
		return nil, err
	}
	return claims, nil
}

// codexAccountID pulls the ChatGPT account id from id_token claims — nested
// under the OpenAI auth namespace, with a top-level fallback.
func codexAccountID(claims map[string]any) string {
	if ns, ok := claims["https://api.openai.com/auth"].(map[string]any); ok {
		if id, ok := ns["chatgpt_account_id"].(string); ok && id != "" {
			return id
		}
	}
	if id, ok := claims["chatgpt_account_id"].(string); ok {
		return id
	}
	return ""
}

func buildCodexAuthorizeURL(challenge, state string) string {
	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", codexOAuthClientID)
	q.Set("redirect_uri", codexRedirectURI)
	q.Set("scope", codexScope)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("state", state)
	q.Set("id_token_add_organizations", "true")
	q.Set("codex_cli_simplified_flow", "true")
	return codexAuthorizeEP + "?" + q.Encode()
}

// ---- OAuth token exchange / refresh (form-encoded, OpenAI style) ----

func codexTokenRequest(ctx context.Context, client *http.Client, form url.Values) (OAuthToken, error) {
	if client == nil {
		client = http.DefaultClient
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, codexTokenEP, strings.NewReader(form.Encode()))
	if err != nil {
		return OAuthToken{}, err
	}
	req.Header.Set("content-type", "application/x-www-form-urlencoded")
	resp, err := client.Do(req)
	if err != nil {
		return OAuthToken{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if resp.StatusCode != http.StatusOK {
		return OAuthToken{}, fmt.Errorf("openai token endpoint %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var tr struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		IDToken      string `json:"id_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(raw, &tr); err != nil {
		return OAuthToken{}, err
	}
	if tr.AccessToken == "" {
		return OAuthToken{}, fmt.Errorf("openai token endpoint returned no access_token")
	}
	tok := OAuthToken{
		AccessToken:  tr.AccessToken,
		RefreshToken: tr.RefreshToken,
		IDToken:      tr.IDToken,
		ExpiresAt:    time.Now().UnixMilli() + tr.ExpiresIn*1000,
	}
	if tr.IDToken != "" {
		if claims, err := decodeJWTPayload(tr.IDToken); err == nil {
			tok.AccountID = codexAccountID(claims)
		}
	}
	return tok, nil
}

func exchangeCodexCode(ctx context.Context, client *http.Client, code, verifier string) (OAuthToken, error) {
	return codexTokenRequest(ctx, client, url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {codexRedirectURI},
		"client_id":     {codexOAuthClientID},
		"code_verifier": {verifier},
	})
}

func refreshCodexToken(ctx context.Context, client *http.Client, refreshToken string) (OAuthToken, error) {
	tok, err := codexTokenRequest(ctx, client, url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"client_id":     {codexOAuthClientID},
		"scope":         {codexScope},
	})
	if err != nil {
		return OAuthToken{}, err
	}
	// Refresh responses may omit refresh_token; keep the old one.
	if tok.RefreshToken == "" {
		tok.RefreshToken = refreshToken
	}
	return tok, nil
}

// ---- loopback login ----

// CodexLogin holds an in-flight loopback login's secret material.
type CodexLogin struct {
	Verifier     string
	State        string
	AuthorizeURL string
}

// NewCodexLogin generates PKCE + state and the authorize URL (loopback redirect).
func NewCodexLogin() (CodexLogin, error) {
	vb := make([]byte, 32)
	if _, err := rand.Read(vb); err != nil {
		return CodexLogin{}, err
	}
	sb := make([]byte, 32)
	if _, err := rand.Read(sb); err != nil {
		return CodexLogin{}, err
	}
	verifier := b64urlNoPad(vb)
	state := b64urlNoPad(sb)
	return CodexLogin{
		Verifier:     verifier,
		State:        state,
		AuthorizeURL: buildCodexAuthorizeURL(pkceChallenge(verifier), state),
	}, nil
}

// RunCodexLoopback starts a one-shot HTTP server on :1455, waits for OpenAI to
// redirect with the auth code, exchanges it for tokens, hands them to onToken
// (which persists them), and shuts down. It blocks until the callback fires, an
// error occurs, or ctx is cancelled (e.g. login timeout).
func RunCodexLoopback(ctx context.Context, login CodexLogin, onToken func(OAuthToken) error) error {
	ln, err := net.Listen("tcp", codexLoopbackAddr)
	if err != nil {
		return fmt.Errorf("cannot start loopback on %s (is another login or codex running?): %w", codexLoopbackAddr, err)
	}
	done := make(chan error, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/callback", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if e := q.Get("error"); e != "" {
			writeLoopbackPage(w, "로그인이 취소되었거나 실패했습니다: "+e)
			done <- fmt.Errorf("oauth error: %s", e)
			return
		}
		if q.Get("state") != login.State {
			writeLoopbackPage(w, "상태 불일치로 로그인을 거부했습니다.")
			done <- fmt.Errorf("oauth state mismatch")
			return
		}
		tok, err := exchangeCodexCode(r.Context(), nil, q.Get("code"), login.Verifier)
		if err != nil {
			writeLoopbackPage(w, "토큰 교환 실패: "+err.Error())
			done <- err
			return
		}
		if err := onToken(tok); err != nil {
			writeLoopbackPage(w, "토큰 저장 실패: "+err.Error())
			done <- err
			return
		}
		writeLoopbackPage(w, "로그인 완료. 이 탭을 닫고 앱으로 돌아가세요.")
		done <- nil
	})
	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()
	defer srv.Close()

	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func writeLoopbackPage(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = io.WriteString(w, "<!doctype html><meta charset=utf-8><body style=\"font-family:sans-serif;padding:40px\"><h2>Rebase</h2><p>"+msg+"</p></body>")
}

// ---- Responses API request builder (verified via spike) ----

// BuildResponsesBody maps a neutral LLMRequest to the ChatGPT Codex Responses API
// body. System prompt -> "instructions"; tool calls/results -> function_call /
// function_call_output items.
func BuildResponsesBody(req ports.LLMRequest) map[string]any {
	input := make([]map[string]any, 0, len(req.Messages))
	for _, m := range req.Messages {
		switch m.Role {
		case ports.RoleUser:
			input = append(input, map[string]any{
				"type": "message", "role": "user",
				"content": []map[string]any{{"type": "input_text", "text": m.Text}},
			})
		case ports.RoleAssistant:
			if m.ToolName != "" {
				args := m.ToolArgs
				if args == nil {
					args = map[string]any{}
				}
				ab, _ := json.Marshal(args)
				input = append(input, map[string]any{
					"type": "function_call", "call_id": m.ToolCallID, "name": m.ToolName, "arguments": string(ab),
				})
			} else {
				input = append(input, map[string]any{
					"type": "message", "role": "assistant",
					"content": []map[string]any{{"type": "output_text", "text": m.Text}},
				})
			}
		case ports.RoleTool:
			input = append(input, map[string]any{
				"type": "function_call_output", "call_id": m.ToolCallID, "output": m.Text,
			})
		}
	}
	body := map[string]any{"model": req.Model, "input": input, "stream": true, "store": false}
	if req.System != "" {
		body["instructions"] = req.System
	}
	if len(req.Tools) > 0 {
		tools := make([]map[string]any, 0, len(req.Tools))
		for _, t := range req.Tools {
			schema := t.Schema
			if schema == nil {
				schema = map[string]any{"type": "object", "properties": map[string]any{}}
			}
			tools = append(tools, map[string]any{
				"type": "function", "name": t.Name, "description": t.Description, "parameters": schema,
			})
		}
		body["tools"] = tools
	}
	return body
}

// parseResponsesStream decodes the Codex Responses SSE stream (response.* events)
// into neutral LLMEvents.
func parseResponsesStream(r io.Reader, emit func(ports.LLMEvent)) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(line[len("data:"):])
		if data == "" || data == "[DONE]" {
			continue
		}
		var ev struct {
			Type  string `json:"type"`
			Delta string `json:"delta"`
			Item  struct {
				Type      string `json:"type"`
				CallID    string `json:"call_id"`
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
			} `json:"item"`
			Response struct {
				Error *struct {
					Message string `json:"message"`
				} `json:"error"`
			} `json:"response"`
		}
		if json.Unmarshal([]byte(data), &ev) != nil {
			continue
		}
		switch ev.Type {
		case "response.output_text.delta":
			if ev.Delta != "" {
				emit(ports.LLMEvent{Kind: ports.EventText, Text: ev.Delta})
			}
		case "response.output_item.done":
			if ev.Item.Type == "function_call" {
				var args map[string]any
				_ = json.Unmarshal([]byte(ev.Item.Arguments), &args)
				emit(ports.LLMEvent{Kind: ports.EventToolCall, ToolCall: &ports.ToolCall{
					ID: ev.Item.CallID, Name: ev.Item.Name, Args: args,
				}})
			}
		case "response.completed":
			emit(ports.LLMEvent{Kind: ports.EventDone})
		case "response.failed", "error", "response.error":
			msg := "responses stream error"
			if ev.Response.Error != nil {
				msg = ev.Response.Error.Message
			}
			emit(ports.LLMEvent{Kind: ports.EventError, Err: msg})
		}
	}
	return sc.Err()
}

// ---- provider ----

// CodexOAuthProvider calls the ChatGPT Codex backend (Responses API) with a
// ChatGPT-subscription OAuth token, refreshing transparently.
type CodexOAuthProvider struct {
	store      OAuthTokenStore
	model      string
	httpClient *http.Client
}

func NewCodexOAuthProvider(store OAuthTokenStore, model string) *CodexOAuthProvider {
	if model == "" {
		model = "gpt-5.4"
	}
	return &CodexOAuthProvider{
		store:      store,
		model:      model,
		httpClient: &http.Client{Timeout: 120 * time.Second},
	}
}

func (c *CodexOAuthProvider) Status(_ context.Context) (ports.ProviderStatus, error) {
	tok, err := c.store.Get()
	if err != nil || tok.AccessToken == "" {
		return ports.ProviderStatus{Ready: false, Detail: "not logged in"}, nil
	}
	return ports.ProviderStatus{Ready: true, Detail: "ChatGPT subscription (" + c.model + ")"}, nil
}

func (c *CodexOAuthProvider) validToken(ctx context.Context) (OAuthToken, error) {
	tok, err := c.store.Get()
	if err != nil || tok.AccessToken == "" {
		return OAuthToken{}, fmt.Errorf("not logged in to ChatGPT")
	}
	if needsRefresh(tok.ExpiresAt, time.Now().UnixMilli()) {
		nt, rerr := refreshCodexToken(ctx, c.httpClient, tok.RefreshToken)
		if rerr != nil {
			return OAuthToken{}, fmt.Errorf("token refresh failed: %w", rerr)
		}
		if nt.AccountID == "" {
			nt.AccountID = tok.AccountID // refresh may omit id_token
		}
		if serr := c.store.Set(nt); serr != nil {
			return OAuthToken{}, serr
		}
		return nt, nil
	}
	return tok, nil
}

func (c *CodexOAuthProvider) Complete(ctx context.Context, req ports.LLMRequest, emit func(ports.LLMEvent)) error {
	if req.Model == "" {
		req.Model = c.model
	}
	tok, err := c.validToken(ctx)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(BuildResponsesBody(req))
	if err != nil {
		return err
	}
	resp, err := c.doResponses(ctx, payload, tok)
	if err != nil {
		return err
	}
	if resp.StatusCode == http.StatusUnauthorized {
		resp.Body.Close()
		nt, rerr := refreshCodexToken(ctx, c.httpClient, tok.RefreshToken)
		if rerr != nil {
			return fmt.Errorf("authentication failed and token refresh failed: %w", rerr)
		}
		if nt.AccountID == "" {
			nt.AccountID = tok.AccountID
		}
		_ = c.store.Set(nt)
		resp, err = c.doResponses(ctx, payload, nt)
		if err != nil {
			return err
		}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("codex responses API %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return parseResponsesStream(resp.Body, emit)
}

func (c *CodexOAuthProvider) doResponses(ctx context.Context, payload []byte, tok OAuthToken) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, codexResponsesURL, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	sb := make([]byte, 16)
	_, _ = rand.Read(sb)
	sessionID := fmt.Sprintf("%x-%x-%x-%x-%x", sb[0:4], sb[4:6], sb[6:8], sb[8:10], sb[10:16])
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "text/event-stream")
	req.Header.Set("authorization", "Bearer "+tok.AccessToken)
	req.Header.Set("chatgpt-account-id", tok.AccountID)
	req.Header.Set("openai-beta", "responses=experimental")
	req.Header.Set("originator", "codex_cli_rs")
	req.Header.Set("session_id", sessionID)
	return c.httpClient.Do(req)
}
