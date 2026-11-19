# CTE result preservation

## Cause and scope

`containsWriteVerb` matches substrings in CTE identifiers and literals. The shared
SQL executor then incorrectly uses the advisory read-only classification to choose
`ExecContext`, silently discarding SELECT results.

## Plan

1. Add failing domain and shared executor tests for CTE identifiers/literals,
   quoted semicolons/comment markers, genuine CTE writes and result clauses.
2. Tokenize SQL without interpreting quoted content as keywords. Keep ambiguous
   syntax conservative for permissions. Decide row delivery independently from
   permissions, using the outer statement and real result clauses.
3. Add isolated Electron E2E coverage for read-only and Write/Auto/Manual queries,
   plus optional local MySQL coverage. Use only disposable databases/tables.
4. Run Go tests/vet, builds and affected Desktop E2E; inspect a result screenshot.

## Tracking and boundaries

Jira searches found no matching Rebase CTE ticket; this repository defines no Jira
project or mandatory ticket creation rule. The user request is the work definition.
Reuse `feature/sql-with`; no new worktree. Production database access is excluded.
The implementation was verified before publication. The user authorized production
release on 2026-11-19: publish the fix PR, merge after CI, then merge the generated
Release Please PR and verify macOS/Windows artifacts and updater metadata.

## Verification

- RED reproduced empty columns/rows with nil error for CTE column names, CTE
  literals and SELECT with a quoted semicolon. Result-clause misrouting also failed.
- GREEN: `go test ./engine/...`, `go vet ./engine/...`, gofmt and
  `git diff --check` passed.
- Engine, renderer and desktop builds passed; affected E2E TypeScript check passed.
- Desktop unit tests: 32 passed.
- Local MySQL integration: connection, one-shot query stream and new CTE result
  cases passed (`-tags=integration`, targeted test names only).
- Electron: new SQLite/MySQL CTE flows, existing SQLite transactions and
  SELECT-without-whitespace permission regression: 6 passed. CTE cases cover
  Read-only, Write Auto and Write Manual. SQLite screenshot inspected at
  `apps/desktop/test-results/query-cte-results-SQLite-d-76387--only-Write-Auto-and-Manual/cte-results.png`.
- Initial MySQL E2E encountered absent `devdb`; the constant-only CTE test now
  connects to `information_schema` without creating a schema or touching user tables.
- PostgreSQL/SQL Server live servers were not exercised. Shared executor tests
  cover write CTE outer SELECT, RETURNING, OUTPUT and OUTPUT INTO routing.
- Read-only exploration was delegated; implementation and verification were
  performed by the main agent. No worktree was created.
