# Claude (Anthropic) OAuth Login for the Agent — Design

**Date:** 2026-06-05
**Status:** Draft (pending user review)
**Phase:** 1 of 2 — Anthropic Claude only. Codex/ChatGPT OAuth is a separate later spec.

## Goal

Let users power the in-app Agent with their **Claude Pro/Max subscription via OAuth**,
with **no API key and no CLI on PATH**. The app stores whether the user is logged in,
runs a browser OAuth login (paste-code flow) when they aren't, remembers the tokens
(with refresh), and calls the Anthropic Messages API directly with the OAuth token —
the same mechanism Claude Code / opencode use.

This replaces the current root cause of the user's bug: the app shells out to a `codex`/
`claude` binary that a Finder-launched macOS app can't find on its minimal PATH, so
detection fails and the login button hides. The new path doesn't depend on a CLI at all.

## Approach & references

Mirror **opencode's Anthropic auth** (client_id `9d1c250a-e61b-44d9-88ed-5944d1962f5e`),
PKCE S256, paste-code flow. Key facts gathered:
- Authorize: `https://claude.ai/oauth/authorize` with `code=true&response_type=code&client_id=…&redirect_uri=https://console.anthropic.com/oauth/code/callback&scope=org:create_api_key user:profile user:inference&code_challenge=…&code_challenge_method=S256&state=…`
- The browser shows an authorization **code that the user copies** (often formatted `CODE#STATE` — split on `#`).
- Token exchange + refresh: `POST https://console.anthropic.com/v1/oauth/token` (`grant_type=authorization_code` with `code`,`code_verifier`,`client_id`,`redirect_uri`; or `grant_type=refresh_token` with `refresh_token`,`client_id`). Returns `access_token`, `refresh_token`, `expires_in`.
- `/v1/messages` is called with the OAuth token plus `anthropic-beta: oauth-2025-04-20,claude-code-20250219` and `anthropic-version: 2023-06-01`.

> **ToS note:** This reuses the official Claude client's OAuth client_id and private
> endpoints, the same as opencode (public, widely used). The user opted into this
> approach explicitly. Documented here for transparency; it can break if Anthropic
> rotates the client_id/endpoints.

## Task 0 — De-risking spike (do FIRST, throwaway)

Sources disagree on two high-risk details. Resolve them empirically before building:
1. Is the OAuth token sent as **`Authorization: Bearer <token>`** (x-api-key omitted) or as **`x-api-key: <token>`**?
2. Is a **required first system block** needed — exactly `"You are Claude Code, Anthropic's official CLI for Claude."` — for OAuth tokens to be accepted?

Spike: a temporary Go `main` (or a `go test` guarded by an env var) that runs the full
flow once — generate PKCE, print the authorize URL, read the pasted code from stdin,
exchange for tokens, then make ONE minimal `/v1/messages` call. Try Bearer first; if it
401s, try x-api-key; try with and without the Claude Code system prompt. **Record the
exact header set + system-prompt requirement that returns 200.** Those become the
constants used by the real adapter. Delete the spike afterward.

## Architecture (token logic lives in the Go engine, like API keys)

The renderer never sees tokens. The engine owns OAuth state + token refresh + the API
call; the main process opens the browser and proxies IPC; the renderer drives the UI.

### 1. Token storage — keychain (`engine/internal/application/connection_service.go`)
Reuse `KeyringStore`. Store one JSON blob per provider under ref `oauth:<provider>`:
```json
{ "access_token": "...", "refresh_token": "...", "expires_at": 1730000000000 }
```
New service methods: `SetOAuth(provider, blob)`, `GetOAuth(provider) (blob, error)`,
`ClearOAuth(provider)`, `HasOAuth(provider) bool`.

### 2. OAuth flow — engine endpoints (`engine/internal/transport/http/agent.go`)
- `POST /agent/oauth/start` `{provider}` → engine generates `code_verifier` (32 random
  bytes, base64url, no padding) + `code_challenge` (S256) + `state`; keeps the pending
  `{verifier,state}` in an in-memory map keyed by provider; returns `{authorizeUrl}`.
- `POST /agent/oauth/complete` `{provider, code}` → split `code` on `#` into `code`+`state`;
  POST to the token endpoint with the stored verifier; on success store the token blob in
  keychain and clear the pending entry; return `{ok:true}`. (Email/plan is not returned by
  the token endpoint; status shows "Logged in" without an email.)
- `GET /agent/oauth/status?provider=` → `{loggedIn: bool, expiresAt?: number}` (loggedIn =
  keychain has a non-empty blob).
- `DELETE /agent/oauth/status?provider=` → clear tokens.

### 3. Pure helpers (TDD) — new `engine/internal/adapters/llm/oauth.go`
- `GeneratePKCE() (verifier, challenge string)` — deterministic given an injected random
  source so it's testable; challenge = base64url(SHA256(verifier)) no padding.
- `ParseAuthCode(pasted string) (code, state string)` — split on first `#`, trim.
- `NeedsRefresh(expiresAt int64, now int64) bool` — true if `now >= expiresAt - 60_000`
  (60s safety margin).
- `BuildAuthorizeURL(challenge, state string) string`.

### 4. LLM adapter — `NewAnthropicOAuthProvider(...)` in `llm/oauth.go`
Reuses the existing `anthropic.go` Messages-API call, with three differences resolved by
the spike:
- Before each call: load tokens; if `NeedsRefresh`, refresh via the token endpoint and
  persist the new blob.
- Auth header per spike result (Bearer or x-api-key), plus the `anthropic-beta` +
  `anthropic-version` headers.
- Prepend the required Claude Code system block (if the spike confirms it's needed).
- `SelfDriving() → false` — the engine's existing tool-dispatch loop drives it, exactly
  like the `anthropic` provider, so MCP tools + data-exposure policy keep working.
On a 401 mid-call: refresh once and retry; if it still fails, return an auth error so the
UI can prompt re-login.

### 5. agent-run wiring (`engine/.../agent.go` Run())
Add a `case "anthropic-oauth"` that constructs `NewAnthropicOAuthProvider`. No apiKey
needed.

### 6. IPC (`apps/desktop/src/main/index.ts`, preload, `global.d.ts`)
- `agent-oauth-start (provider)` → engine start → `shell.openExternal(authorizeUrl)` →
  `{ok}`.
- `agent-oauth-complete (provider, code)` → engine complete → `{ok}`.
- `agent-oauth-status (provider)` → engine status → `{loggedIn, expiresAt?}`.
- `agent-oauth-logout (provider)` → engine clear → `{ok}`.
Mirror in preload + `global.d.ts` types.

### 7. Renderer (`apps/renderer/src/components/AgentChat.tsx`)
- Add provider option `anthropic-oauth` labelled "Claude (구독 로그인 — API 키 불필요)".
- When selected, show OAuth status: "로그인됨" (green) or "로그인 필요".
- **Log in** button → `agentOAuthStart` (opens browser) → reveal a "인증 코드 붙여넣기"
  input + "완료" button → `agentOAuthComplete(code)` → refresh status.
- **로그아웃** button → `agentOAuthLogout`.
- Reuse existing `agentRun` with `provider: 'anthropic-oauth'`.

## Error handling
- Token exchange/refresh non-200 → surface the provider error text to the UI.
- Expired/invalid refresh token → status flips to logged-out; UI shows "다시 로그인".
- Pasted code malformed → "코드 형식이 올바르지 않습니다".

## Testing / verification
- **Spike**: live, manual — confirms headers + system prompt (Task 0).
- **TDD (pure)**: `oauth.go` helpers — PKCE challenge correctness, `ParseAuthCode`,
  `NeedsRefresh` boundaries, `BuildAuthorizeURL`.
- **Engine integration**: token store get/set/clear round-trip.
- **Live**: full login (browser → paste code) then send a real Agent message via
  `anthropic-oauth` and confirm a streamed response; verify refresh by forcing an expired
  `expires_at` and confirming a transparent refresh.
- No automated test hits Anthropic in CI (no creds there); live checks are manual/CDP.

## Out of scope (Phase 2+)
- Codex / ChatGPT OAuth (separate spec — messier, undocumented backend).
- GitHub Copilot or other providers.
- Auto-migrating existing `cli`/`codex` provider settings.

## Files
- New: `engine/internal/adapters/llm/oauth.go` (+ `oauth_test.go`)
- Modify: `engine/internal/adapters/llm/anthropic.go` (extract a shared Messages call or
  parameterize auth/headers/system prompt)
- Modify: `engine/internal/application/connection_service.go` (OAuth keychain methods)
- Modify: `engine/internal/transport/http/agent.go` (oauth endpoints + provider case)
- Modify: `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`,
  `apps/renderer/src/global.d.ts` (IPC)
- Modify: `apps/renderer/src/components/AgentChat.tsx` (UI)
