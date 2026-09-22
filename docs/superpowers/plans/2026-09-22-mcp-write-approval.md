# MCP write approval and per-connection write policy

## Goal

Allow an external MCP client to propose a write and have Rebase execute it only
after an explicit approval for that connection, while keeping read-only MCP as
the default.

## Design

- Add a persisted per-connection `mcpWriteMode` with `disabled` (default) and
  `approval_required` values. The existing connection `readOnly` flag remains a
  hard lower-level guard.
- Persist MCP write proposals in the local metadata SQLite database. A
  proposal contains the profile, exact SQL needed for approval execution,
  classification, status, timestamps, and execution outcome. Activity records
  redact connection secrets; the proposal itself remains local so approval can
  execute exactly what the MCP client submitted.
- When `mcpWriteMode=approval_required`, `propose_write` creates a pending
  proposal and returns its ID plus the risk assessment. It never executes.
- Add MCP proposal status lookup so the external client can observe that the
  user approved/rejected a proposal and retrieve the execution result.
- Add authenticated engine endpoints and renderer IPC for listing pending
  proposals and approving/rejecting them. Approval executes the stored SQL in
  the engine, not in the renderer, then records rows affected or a safe error.
- Add a connection MCP settings control for the write mode and an MCP
  activity approval card with approve/reject actions.
- Keep DDL and high-risk DML behind the same approval flow; the connection
  `readOnly` setting and existing SQL policy remain enforced.

## Verification

- Domain tests for write-mode defaults and proposal status transitions.
- SQLite repository round-trip tests for proposals.
- Agent/MCP tests for pending proposals and status lookup without execution.
- HTTP/engine tests for approval execution and rejection.
- Renderer tests/build and a live Electron E2E that proposes a write, approves
  it in the MCP activity UI, and verifies the test SQLite row changed.
