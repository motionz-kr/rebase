# Query risk confirmation flow

## Goal

Make risky `UPDATE`/write execution behave like a desktop SQL client: the
user's explicit `실행` action in the risk dialog should authorize the current
statement and continue execution without requiring a separate global Write
mode toggle or repeated policy-banner clicks.

## Scope

- Preserve the existing risk analysis dialog and engine-side policy gate.
- Treat an explicit confirmation in `RiskConfirmDialog` as per-execution
  approval for `allowWrite`, destructive confirmation, and acknowledgement.
- Do not persist or silently change the editor's global Read-only/Write toggle.
- Keep policy banners as a fallback for profile-level read-only restrictions,
  analysis failures, and other execution paths.
- Add pure unit coverage for the approval merge and a desktop E2E assertion for
  the one-confirmation write flow using a temporary SQLite database.

## Implementation sequence

1. Add a failing renderer unit test describing the explicit approval merge.
2. Implement the smallest pure helper and use it from `QueryEditor` when the
   risk dialog continues a pending execution.
3. Add a regression E2E flow that starts in Read-only mode, confirms an
   `UPDATE ... WHERE`, and verifies the row changed without clicking a policy
   banner.
4. Run renderer/engine unit tests and the focused E2E; inspect the live app
   flow and ensure the temporary database is removed by the fixture.

## Acceptance criteria

- Read-only editor + `UPDATE ... WHERE` requires one risk-dialog execution
  confirmation after the initial Run click, then executes successfully.
- `UPDATE` without `WHERE` still requires the risk confirmation and engine
  destructive confirmation, but both are satisfied by that same explicit
  dialog action when permitted by the connection profile.
- The global Write toggle remains unchanged after the one-off confirmation.
- A profile configured as read-only remains blocked by the engine.
- Existing policy and transaction behavior remains intact.
