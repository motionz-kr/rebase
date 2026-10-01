# Unified MCP access to Rebase connection profiles

**Status:** Complete

## Goal

Register one Rebase MCP server in an external AI client and let it choose among
the Rebase connection profiles that have MCP exposure enabled. Each selected
profile must continue to enforce its own database/schema/table scope, read-only
setting, and write policy.

## Current behavior

The generated config registers one stdio process per connection profile. Each
process loads a single profile at startup, so three saved profiles appear as
three MCP servers with duplicate tools. The generated `-token mcp` argument is
a required placeholder for engine startup, not an authentication credential;
stdio already connects the client and child process through local pipes.

## Design

- Add a unified MCP mode alongside the existing profile-specific mode so old
  manually configured entries continue to work.
- The unified server exposes `list_connections`, returning only the ID, name,
  driver, and default database of MCP-enabled SQL profiles.
- Add a required `connectionId` argument to each routed SQL tool. Dispatch to
  that profile's existing SQL registry so its MCP scope and write policy remain
  authoritative.
- Keep MCP exposure, database/schema/table allowlists, and write policy stored
  per connection profile. A unified server entry does not grant access to
  profiles whose MCP exposure is disabled.
- Generate one client entry (`rebase-databases`) that starts unified mode.
  Auto-connect removes prior Rebase-generated profile entries while preserving
  unrelated client configuration and backing it up.
- Remove the placeholder token from newly generated stdio commands while
  continuing to accept the legacy CLI argument. Document that stdio does not
  use a bearer token.
- Keep the per-profile MCP settings UI, but explain that the generated client
  entry is shared and that changing the eligible profile set requires the AI
  client to restart.

## Implementation sequence

1. Add failing Go tests for connection discovery, profile routing, and
   per-profile scope enforcement; implement a multi-profile tool registry.
2. Add failing renderer/config merge tests for the unified command and safe
   replacement of legacy Rebase entries; implement config migration.
3. Wire unified mode into engine startup while retaining profile-specific mode.
4. Update the connection MCP panel and MCP documentation.
5. Add a desktop E2E flow with three isolated profiles and a real stdio MCP
   process; verify discovery and distinct per-profile access policies.
6. Build the renderer and engine, run focused tests and E2E, then manually
   inspect the live app flow.

## Verification

- Go unit test: one registry lists and routes multiple profiles; a call using
  another profile's table is denied by that profile's scope.
- Renderer unit tests: snippets use one unified entry and config migration
  preserves unrelated servers while replacing legacy Rebase entries.
- Desktop E2E: create three disposable profiles in the isolated fixture,
  enable MCP independently, run the unified stdio process, and verify the
  returned profile choices and access boundaries. No external DB data is
  changed; policy denials occur before any database connector call.
- Build renderer, desktop TypeScript, and Go engine.

## Results

- Unified MCP registry and stdio activity attribution unit tests pass.
- Renderer and desktop unit suites pass; renderer, desktop TypeScript, and engine
  builds pass.
- The focused Electron E2E creates three enabled profiles plus one disabled
  profile, verifies one shared MCP entry, lists only the enabled profiles, and
  confirms each selected profile enforces its own table scope.
- A full `go test ./...` run was attempted. Unrelated tests could not complete in
  this restricted host because OS Keychain authorization and local socket/network
  operations are denied. The changed engine packages and command compile tests
  pass.

## Risks / constraints

- External MCP clients may cache tool descriptions until restarted.
- Existing profile-specific MCP entries need deterministic migration to avoid
  duplicate Rebase servers after auto-connect.
- The stdio transport has no global bearer-token authentication. Per-profile
  MCP enablement and scopes remain the authorization boundary.
