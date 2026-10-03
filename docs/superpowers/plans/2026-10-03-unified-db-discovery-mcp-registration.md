# Unified local database discovery and MCP registration

**Status:** Implementation and focused validation complete; full E2E suite withheld to protect an unrelated local database

## Goal

Let a Rebase user find databases available on the current PC through one
discovery flow, regardless of whether a service runs directly on the host or in
a locally published Docker container. Let an MCP client request a connection
profile create/update, with the user reviewing and approving the change in
Rebase. Keep database work governed by each profile's engine-enforced MCP
write mode and database/schema/table scope.

## Scope and safety boundaries

- The UI exposes one "내 PC에서 데이터베이스 찾기" action. Local TCP probes and
  Docker's local published-port inventory run behind that action.
- Probe loopback and the known supported database ports only. Inspect only the
  active local Docker context, using an argument array and a bounded timeout.
  Never scan arbitrary networks or read container environment variables.
- Return candidates with driver, loopback endpoint, and optional container
  label. Deduplicate candidates by endpoint. Do not infer or store credentials.
- MCP discovery is read-only. MCP connection changes are pending proposals;
  Rebase reviews the field diff, performs the connection test, and collects
  credentials in its own UI before saving.
- MCP cannot set credentials, `secretRef`, credential-bearing `connectionUri`,
  MCP exposure, write mode, read-only state, or access allowlists. New profiles
  start MCP-disabled with writes disabled. Updates preserve existing policy.
- Keep existing per-profile write modes (disabled, approval required, full
  access) and DB/schema/table enforcement in the engine. Before exposing a new
  profile to MCP, require an explicit permission choice and show that an empty
  allowlist means unrestricted access.
- Refresh the unified MCP profile registry after approval so the new/updated
  profile can be used without restarting the AI client. Do not broaden the
  profile set beyond MCP-enabled profiles.
- SQLite remains a file-picker flow; do not recursively scan the disk for DB
  files.

## Implementation sequence

1. Add domain candidate/proposal types and ports, then failing tests for bounded
   local discovery, redacted MCP proposals, immutable policy fields, and stale
   update rejection.
2. Implement local loopback port discovery and local Docker published-port
   inventory behind an application use case. Treat unavailable Docker as a
   partial discovery result.
3. Add one renderer discovery action and candidate picker that reuses the
   existing connection form, test, and profile-save flow.
4. Add SQLite persistence and engine routes for pending MCP profile proposals,
   plus MCP discovery/propose tools. Keep proposal output free of credentials
   and secret references.
5. Add proposal review to MCP Activity. Apply only an approved, current
   proposal; collect credentials and explicitly select MCP exposure/scope/write
   policy in Rebase. Keep profile policy updates atomic.
6. Make unified MCP dispatch load the current MCP-enabled profiles and their
   latest policies, so an approved profile is available without restarting the
   external client. Preserve profile-specific routing and authorization.
7. Add focused domain/application/adapter/UI tests and a Playwright flow using
   isolated fake database endpoints and a fake Docker CLI. Build the engine,
   renderer, and desktop app, then interact with the live app flow.

## Acceptance criteria

- A single discovery action returns locally reachable supported DB candidates
  from host services and locally published Docker containers without asking the
  user which source to search.
- Selecting a candidate fills the existing connection form; it is not saved
  until the connection test succeeds and the user saves it.
- MCP can discover candidates and submit a create/update proposal without
  handling secrets or changing profile permissions.
- Rebase shows the proposed fields, gathers credentials locally, tests the
  connection, and requires explicit approval before applying the profile
  change.
- MCP database writes remain disabled by default and are governed per profile;
  out-of-scope database/schema/table requests are denied by the engine.
- After approval, MCP can list and use the profile without restarting the
  client, subject to the profile's explicit MCP exposure and write settings.
- Docker unavailable, remote Docker context, no candidate, wrong service, and
  authentication-required cases produce clear partial/empty/error states.

## Verification

- Go domain, application, adapter, and HTTP tests for discovery, proposal
  approval, policy preservation, redaction, and MCP routing.
- Renderer tests for unified discovery results and profile form population.
- Playwright E2E uses a fake Docker CLI and isolated app metadata to verify the
  unified discovery picker, that discovered profiles cannot save before a
  successful test, and that MCP create proposals enter Rebase review and also
  cannot save before a successful test. Proposal state stays in the fixture's
  isolated temporary metadata database; no personal DB is contacted or changed.
- A disposable MySQL E2E verifies an MCP proposal can pass connection test,
  save with MCP disabled/write-disabled and a database allowlist, then become
  visible to an already-running unified MCP process after explicit exposure.
  Its only SQL is `SELECT 1`; the temporary container is bound to loopback and
  removed after the test.
- The complete E2E suite is not run because its MySQL cases target
  `127.0.0.1:3306`, which belongs to another workspace's `backend-db-1`.
  Feature E2E and DB-free smoke cases are run independently to avoid writing to
  that unrelated database.

## Validation state

- `pnpm install --frozen-lockfile` passed. Go 1.25.7 was unpacked under
  `/private/tmp` after its official SHA-256 checksum matched.
- `go test ./...` passed across all engine packages; `pnpm build` passed for
  the engine, renderer, and desktop.
- Renderer tests passed: 62 files, 458 tests. Desktop unit tests passed: 5
  files, 29 tests.
- `pnpm --filter renderer lint` reported no errors and 3 hook-dependency
  warnings in unchanged `ConnectionTablePrefs.tsx` and `QueryEditor.tsx`.
- Playwright passed the discovery and save-gate flows, database-free smoke
  flows, dynamic per-profile MCP governance, and the disposable MySQL
  registration plus post-save `SELECT 1` flow. After removing the DB fixture,
  the discovery/smoke run was 4 passed and 1 expected skip.
- `git diff --check` passed. The complete E2E suite was intentionally not run
  because its MySQL cases would write to the unrelated local `backend-db-1`.

## Risks

- Docker CLI/context behavior differs across macOS and Windows. Remote contexts
  must be excluded from local discovery, and missing CLI/daemon must not fail
  ordinary loopback discovery.
- MCP stdio clients may cache tool definitions. The implementation must keep a
  stable tool set and resolve enabled profiles/policies dynamically at request
  time.
- Existing empty allowlists mean unrestricted scope for compatibility. New
  registration must not silently opt a profile into unrestricted MCP access.
