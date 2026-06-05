package llm

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/smlee/database-local-engine/engine/internal/ports"
)

// Anthropic OAuth (Claude Pro/Max) constants. These mirror the official Claude
// client / opencode: the app authenticates with the user's subscription via
// browser OAuth (PKCE) and calls the Messages API with the resulting token — no
// API key. See docs/superpowers/specs/2026-06-05-claude-oauth-login-design.md.
const (
	anthropicOAuthClientID    = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
	anthropicOAuthRedirectURI = "https://console.anthropic.com/oauth/code/callback"
	anthropicAuthorizeEP      = "https://claude.ai/oauth/authorize"
	anthropicTokenEP          = "https://console.anthropic.com/v1/oauth/token"
	anthropicOAuthScope       = "org:create_api_key user:profile user:inference"
	anthropicOAuthBeta        = "oauth-2025-04-20"
	// The OAuth (subscription) path requires the model to identify as Claude Code.
	claudeCodeSystemPrompt = "You are Claude Code, Anthropic's official CLI for Claude."
	refreshMarginMillis    = 60_000 // refresh 60s before expiry
)

// OAuthToken is the persisted credential blob (stored in the OS keychain).
type OAuthToken struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresAt    int64  `json:"expires_at"` // epoch millis
}

// OAuthTokenStore loads/saves the token blob (keychain-backed in production).
type OAuthTokenStore interface {
	Get() (OAuthToken, error)
	Set(OAuthToken) error
}

// ---- pure helpers (unit-tested) ----

func b64urlNoPad(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return b64urlNoPad(sum[:])
}

// parseAuthCode splits the pasted "code#state" value on the first '#'.
func parseAuthCode(pasted string) (code, state string) {
	pasted = strings.TrimSpace(pasted)
	if i := strings.Index(pasted, "#"); i >= 0 {
		return pasted[:i], pasted[i+1:]
	}
	return pasted, ""
}

func needsRefresh(expiresAt, now int64) bool {
	return now >= expiresAt-refreshMarginMillis
}

func buildAuthorizeURL(challenge, state string) string {
	q := url.Values{}
	q.Set("code", "true")
	q.Set("client_id", anthropicOAuthClientID)
	q.Set("response_type", "code")
	q.Set("redirect_uri", anthropicOAuthRedirectURI)
	q.Set("scope", anthropicOAuthScope)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	q.Set("state", state)
	return anthropicAuthorizeEP + "?" + q.Encode()
}

// ---- exported flow API (used by the HTTP transport) ----

// PKCEParams is one in-flight OAuth attempt's secret material.
type PKCEParams struct {
	Verifier     string
	State        string
	AuthorizeURL string
}

// NewAnthropicPKCE generates a verifier/state and the authorize URL the user
// opens in their browser.
func NewAnthropicPKCE() (PKCEParams, error) {
	vb := make([]byte, 32)
	if _, err := rand.Read(vb); err != nil {
		return PKCEParams{}, err
	}
	sb := make([]byte, 32)
	if _, err := rand.Read(sb); err != nil {
		return PKCEParams{}, err
	}
	verifier := b64urlNoPad(vb)
	state := b64urlNoPad(sb)
	return PKCEParams{
		Verifier:     verifier,
		State:        state,
		AuthorizeURL: buildAuthorizeURL(pkceChallenge(verifier), state),
	}, nil
}

// ExchangeAnthropicCode trades a pasted authorization code for tokens.
func ExchangeAnthropicCode(ctx context.Context, client *http.Client, pastedCode, verifier string) (OAuthToken, error) {
	code, state := parseAuthCode(pastedCode)
	return anthropicTokenRequest(ctx, client, map[string]string{
		"grant_type":    "authorization_code",
		"code":          code,
		"state":         state,
		"code_verifier": verifier,
		"client_id":     anthropicOAuthClientID,
		"redirect_uri":  anthropicOAuthRedirectURI,
	})
}

func refreshAnthropicToken(ctx context.Context, client *http.Client, refreshToken string) (OAuthToken, error) {
	return anthropicTokenRequest(ctx, client, map[string]string{
		"grant_type":    "refresh_token",
		"refresh_token": refreshToken,
		"client_id":     anthropicOAuthClientID,
	})
}

func anthropicTokenRequest(ctx context.Context, client *http.Client, body map[string]string) (OAuthToken, error) {
	if client == nil {
		client = http.DefaultClient
	}
	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, anthropicTokenEP, bytes.NewReader(payload))
	if err != nil {
		return OAuthToken{}, err
	}
	req.Header.Set("content-type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return OAuthToken{}, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if resp.StatusCode != http.StatusOK {
		return OAuthToken{}, fmt.Errorf("oauth token endpoint %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	var tr struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(raw, &tr); err != nil {
		return OAuthToken{}, err
	}
	if tr.AccessToken == "" {
		return OAuthToken{}, fmt.Errorf("oauth token endpoint returned no access_token")
	}
	return OAuthToken{
		AccessToken:  tr.AccessToken,
		RefreshToken: tr.RefreshToken,
		ExpiresAt:    time.Now().UnixMilli() + tr.ExpiresIn*1000,
	}, nil
}

// ---- provider ----

// AnthropicOAuthProvider calls the Anthropic Messages API with a subscription
// OAuth token (Bearer), refreshing transparently. It reuses the Anthropic body
// builder + SSE decoder; the differences are the auth header, the required
// Claude Code system block, and the anthropic-beta flag.
type AnthropicOAuthProvider struct {
	store      OAuthTokenStore
	model      string
	baseURL    string
	maxTokens  int
	httpClient *http.Client
}

func NewAnthropicOAuthProvider(store OAuthTokenStore, model, baseURL string) *AnthropicOAuthProvider {
	if baseURL == "" {
		baseURL = defaultAnthropicBaseURL
	}
	if model == "" {
		model = "claude-sonnet-4-6"
	}
	return &AnthropicOAuthProvider{
		store:      store,
		model:      model,
		baseURL:    strings.TrimRight(baseURL, "/"),
		maxTokens:  defaultMaxTokens,
		httpClient: &http.Client{Timeout: 120 * time.Second},
	}
}

func (a *AnthropicOAuthProvider) Status(_ context.Context) (ports.ProviderStatus, error) {
	tok, err := a.store.Get()
	if err != nil || tok.AccessToken == "" {
		return ports.ProviderStatus{Ready: false, Detail: "not logged in"}, nil
	}
	return ports.ProviderStatus{Ready: true, Detail: "Claude subscription (" + a.model + ")"}, nil
}

func (a *AnthropicOAuthProvider) Complete(ctx context.Context, req ports.LLMRequest, emit func(ports.LLMEvent)) error {
	if req.Model == "" {
		req.Model = a.model
	}
	tok, err := a.validToken(ctx)
	if err != nil {
		return err
	}

	body := BuildAnthropicBody(req, a.maxTokens)
	// OAuth requires the first system block to be the Claude Code identity.
	sys := []map[string]any{{"type": "text", "text": claudeCodeSystemPrompt}}
	if req.System != "" {
		sys = append(sys, map[string]any{"type": "text", "text": req.System})
	}
	body["system"] = sys
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}

	resp, err := a.doMessages(ctx, payload, tok.AccessToken)
	if err != nil {
		return err
	}
	// A 401 likely means the token expired between the check and the call —
	// refresh once and retry.
	if resp.StatusCode == http.StatusUnauthorized {
		resp.Body.Close()
		nt, rerr := refreshAnthropicToken(ctx, a.httpClient, tok.RefreshToken)
		if rerr != nil {
			return fmt.Errorf("authentication failed and token refresh failed: %w", rerr)
		}
		_ = a.store.Set(nt)
		resp, err = a.doMessages(ctx, payload, nt.AccessToken)
		if err != nil {
			return err
		}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("anthropic API %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return parseSSEStream(resp.Body, emit)
}

// validToken loads the stored token, refreshing proactively if near expiry.
func (a *AnthropicOAuthProvider) validToken(ctx context.Context) (OAuthToken, error) {
	tok, err := a.store.Get()
	if err != nil || tok.AccessToken == "" {
		return OAuthToken{}, fmt.Errorf("not logged in to Claude")
	}
	if needsRefresh(tok.ExpiresAt, time.Now().UnixMilli()) {
		nt, rerr := refreshAnthropicToken(ctx, a.httpClient, tok.RefreshToken)
		if rerr != nil {
			return OAuthToken{}, fmt.Errorf("token refresh failed: %w", rerr)
		}
		if serr := a.store.Set(nt); serr != nil {
			return OAuthToken{}, serr
		}
		return nt, nil
	}
	return tok, nil
}

func (a *AnthropicOAuthProvider) doMessages(ctx context.Context, payload []byte, accessToken string) (*http.Response, error) {
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, a.baseURL+"/v1/messages", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("accept", "text/event-stream")
	httpReq.Header.Set("anthropic-version", anthropicVersion)
	httpReq.Header.Set("anthropic-beta", anthropicOAuthBeta)
	httpReq.Header.Set("authorization", "Bearer "+accessToken)
	return a.httpClient.Do(httpReq)
}
