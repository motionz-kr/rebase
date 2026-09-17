# MCP Governance, Scope, and Activity — Implementation Plan

**Goal:** Make MCP operations governable in the desktop app: persist and show connection activity, provide explicit database/profile and schema/table allowlists, and verify the policy on the engine side rather than treating renderer visibility as access control.

**Scope:** Both directions are covered. Rebase-as-MCP-server gets profile/database/scope enforcement and inbound activity records. The Agent's external MCP client gets persisted test/call activity and a recent-status view. Existing data-exposure and non-mutating write-proposal behavior remains unchanged.

**Compatibility decisions:**

- The current desktop workspace is single-workspace, so database governance is
  stored per exposed connection profile as exact database names. A profile's
  configured database is the default scope; an explicit database allowlist is
  enforced on tool calls.
- Schema and table allowlists use exact, case-sensitive identifiers as returned by the active driver. An empty schema/table list preserves current behavior for existing profiles; once configured, only listed objects are exposed.
- “Connected” is presented as `configured` plus `last activity`, not as a permanent live session. Inbound stdio sessions are ephemeral; outbound servers are dialed per agent run/call.
- Secrets remain in the keychain and are never returned in DTOs or activity records. Raw SQL is not stored in MCP activity logs; store a normalized tool name and a safe query fingerprint only where needed.

## Phase 1 — Domain, ports, and SQLite persistence (TDD)

1. Add a pure MCP scope value object with database, schema, and table matching.
2. Add a pure activity model for inbound sessions, outbound server tests/calls, auto-connect/configuration events, status, duration, and safe error category.
3. Add ports for workspace MCP settings and MCP activity persistence; extend the profile repository for serialized scope fields.
4. Add migrations for workspace MCP settings, profile scope columns, and `mcp_activity_events` with indexes by workspace/profile/server/time.
5. Add SQLite repository tests and application fake-port tests before implementation.

## Phase 2 — Engine enforcement and activity recording (TDD)

1. Apply the profile MCP-enabled check before `-mcp <profileId>` starts and
   enforce the persisted database/schema/table scope in the registry.
2. Pass the profile scope into the DB tool registry. Filter metadata results and reject disallowed table/schema references for all table tools and `run_select`/`explain_query` paths.
3. Add a small SQL reference validator at the policy boundary; reject ambiguous or unparseable statements when an allowlist is active.
4. Record inbound initialize/session close/tool success/tool error events and outbound test/call/attach failures through the activity port.
5. Replace the current MCP settings stub with persisted GET/POST behavior and add activity/status endpoints with token checks, pagination, and filters.
6. Add unit and transport tests for allowed/denied database, schema, table, and query cases, plus activity redaction.

## Phase 3 — Electron bridge and renderer UI

1. Extend preload/main IPC for MCP settings, scope, recent status, and paginated activity.
2. Add a workspace-level MCP governance section listing connection profiles with allowed/disabled toggles.
3. Extend the connection MCP tab with database/schema/table allowlist controls and a clear “UI hidden only vs MCP denied” distinction.
4. Show configured client entries, last handshake/test/call status, timestamps, and error summaries. Keep copy-snippet and auto-connect behavior, but label auto-connect as configuration and retain backup information.
5. Show external server test results and recent activity; preserve existing env/header secret handling and trusted/untrusted execution gates.
6. Add renderer tests for scope editing, status labels, pagination/filtering, and safe error display.

## Phase 4 — Live verification and documentation

1. Add isolated Playwright coverage for the MCP panel, allowlist denial, test status, activity rendering, and copy/autoconnect using temporary engine metadata and temporary client config paths.
2. Run the real MCP handshake and `tools/list`/`tools/call` flow against an `e2e_*` database fixture; verify denied objects cannot be read and metadata policy still withholds values.
3. Run renderer/desktop builds and targeted Go tests, then the relevant desktop E2E suite.
4. Update `docs/mcp-server.md`, `docs/security.md`, and architecture notes with the enforced scope and activity model.

## Completion criteria

- MCP access is denied by engine policy when a profile, schema, table, or SQL reference is outside the configured scope.
- UI clearly exposes and persists configuration, recent status, and activity history without exposing secrets or raw sensitive SQL.
- Copy and auto-connect preserve existing client config and backups.
- Targeted unit, integration, and isolated live E2E tests pass.
