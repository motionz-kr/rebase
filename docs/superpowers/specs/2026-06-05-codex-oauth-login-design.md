# Codex (ChatGPT) OAuth Login for the Agent — Design (Phase 2)

**Date:** 2026-06-05
**Status:** Draft (pending user review)
**Phase:** 2 of 2 — ChatGPT/Codex. Builds on the Phase-1 Claude OAuth architecture.

## Goal

Power the Agent with a **ChatGPT Plus/Pro subscription via OAuth** (no API key, no
codex CLI), mirroring how the codex CLI / opencode plugins do it. Same shape as the
Phase-1 Claude work (tokens in keychain via the engine, renderer never sees them), but
OpenAI's flow differs in three ways that make it bigger:

1. **Loopback callback, not paste-code.** OpenAI's `redirect_uri` is fixed to
   `http://localhost:1455/auth/callback`, so the engine must run a temporary loopback
   HTTP server to catch the `?code=&state=` redirect.
2. **account_id from the id_token JWT.** The Codex backend needs a `chatgpt-account-id`
   header, decoded from the OAuth `id_token` JWT claims.
3. **ChatGPT Codex backend (Responses API), not Chat Completions.** Calls go to
   `https://chatgpt.com/backend-api/codex/responses` in the **Responses API** format with
   its own streaming event shape — a new adapter + SSE decoder, NOT the existing
   `openai.go` Chat Completions provider.

## Confirmed facts (from codex CLI / opencode plugins)

- Authorize: `https://auth.openai.com/oauth/authorize`
- Token (exchange + refresh): `https://auth.openai.com/oauth/token`
- client_id: `app_EMoamEEZ73f0CkXaXp7hrann`
- redirect_uri: `http://localhost:1455/auth/callback`
- PKCE S256; scopes include `openid profile email offline_access`
- Model API base: `https://chatgpt.com/backend-api/codex` → `POST /responses`
- Models: `gpt-5.2`, `gpt-5.2-codex`, `gpt-5.3-codex`, etc. (subscription-specific)

## Task 0 — De-risking spike (do FIRST)

Like Phase 1, the exact required headers + Responses request/stream shape vary across
sources. Spike: after a real login, make ONE `POST /backend-api/codex/responses` call and
record what returns 200 + how the stream decodes. Lock these before building the adapter:
- Required headers: `Authorization: Bearer <access>`, `chatgpt-account-id: <id>`,
  `OpenAI-Beta: responses=experimental`, `originator: codex_cli_rs`, `session_id: <uuid>`,
  `Accept: text/event-stream` — confirm which are mandatory and exact values.
- Request body (Responses format): `{ model, instructions, input:[...], tools, stream:true,
  store:false }` — confirm field names.
- Stream events: `response.output_text.delta`, `response.output_item.added/done`,
  `response.completed`, function-call items — confirm names for the decoder.
- account_id JWT claim path (e.g. `https://api.openai.com/auth` → `chatgpt_account_id`).

## Architecture (reuses Phase-1 pieces where possible)

### 1. Keychain token blob — extend `OAuthToken`
Add `IDToken string` and `AccountID string` to the stored blob (Phase-1 struct gains two
optional fields; Anthropic leaves them empty). Same `oauth:<provider>` keychain ref, with
`provider = "openai"`.

### 2. OAuth flow — engine (`llm/codex_oauth.go` + transport)
- `NewCodexPKCE()` → verifier/state + authorize URL (loopback redirect).
- A **loopback server**: the engine starts a one-shot `http.Server` on `127.0.0.1:1455`
  serving `/auth/callback`, captures `code`+`state`, exchanges for tokens, decodes the
  id_token for `account_id`, stores the blob, then shuts the server down. Returns a small
  HTML "you can close this tab" page.
- Endpoints reuse the Phase-1 surface with a `provider=openai` value:
  - `POST /agent/oauth/start {provider:"openai"}` → start loopback + return authorizeUrl.
  - `GET /agent/oauth/status?provider=openai`, `DELETE …` (clear) — already generic.
  - (No `complete` for openai — the loopback completes it; `complete` stays for paste-code
    providers like Anthropic.)
- `parseJWTClaim(idToken, path)` pure helper (TDD) to pull `chatgpt_account_id`.

### 3. LLM adapter — `CodexOAuthProvider` (`llm/codex_oauth.go`)
- Loads the token blob; refreshes via `auth.openai.com/oauth/token` (grant_type=refresh_token)
  with the 60s margin (reuse `needsRefresh`).
- Builds a **Responses API** request from the neutral `LLMRequest` (new `BuildResponsesBody`)
  and POSTs to `chatgpt.com/backend-api/codex/responses` with the spike-confirmed headers.
- A new **Responses SSE decoder** maps `response.*` events to neutral `LLMEvent`s
  (text deltas, function/tool calls, done). Unit-tested with captured sample events.
- `SelfDriving() → false` — reuse the existing agent tool-dispatch loop + data-exposure
  policy, exactly like the other non-CLI providers.

### 4. Transport wiring (`transport/http/agent.go`)
- `case "openai-oauth"` in `Run()` → `NewCodexOAuthProvider(store{provider:"openai"}, model)`.
- `start` handler branches on provider: `anthropic` → paste-code (Phase 1), `openai` →
  loopback.

### 5. Renderer (`AgentChat.tsx`)
- Provider option `openai-oauth` — "Codex / ChatGPT (구독 로그인)".
- Login button → `agentOAuthStart('openai')` (opens browser; loopback auto-completes, no
  paste step) → poll `agentOAuthStatus('openai')` until `loggedIn`. Logout reuses Phase 1.
- Model picker offers the codex models; default a verified one (locked by spike).

## Error handling
- Loopback timeout (user never finishes) → status stays logged-out; surface a message.
- Region/account not eligible (OpenAI returns 403 in some regions — seen in codex issues) →
  surface the provider error verbatim so the user knows it's an account limitation.
- 401 mid-call → refresh once + retry (reuse Phase-1 pattern).

## Testing / verification
- TDD pure: `parseJWTClaim`, `BuildResponsesBody`, the Responses SSE decoder (sample events),
  loopback `code`/`state` parsing.
- Spike: live — confirms headers + stream shape.
- Live E2E (CDP): browser login → loopback completes → real Agent message streams a response.

## Out of scope
- Reusing/​migrating the old `codex`/`cli` CLI providers (kept as-is).
- Non-subscription OpenAI (API key) — unchanged.

## Files
- New: `engine/internal/adapters/llm/codex_oauth.go` (+ `_test.go`), Responses decoder.
- Modify: `llm/oauth.go` (OAuthToken gains IDToken/AccountID), `transport/http/agent.go`
  (loopback start + openai-oauth case), `connection_service.go` (unchanged — generic).
- Modify: `AgentChat.tsx` (openai-oauth provider + models).
- The `agent-oauth-*` IPC is already generic (provider param) — likely no preload change.
