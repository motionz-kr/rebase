# Query Console Transaction Controls

## Goal

Add DataGrip-style Auto/Manual transaction mode to each SQL query tab, with visible transaction state and explicit Commit/Rollback controls. Manual transactions must remain bound to one database connection for that tab and must never be committed implicitly when a tab/session closes.

## Current behavior

`ExecuteQueryStream` currently opens and closes a connection for every request. `ExecuteBatch` creates a short-lived transaction and commits the full batch immediately on success. Neither path can preserve a transaction between separate editor executions.

## Design

- Add an adapter-level query-session capability and a shared adapter utility that owns a dedicated `sql.DB`, `sql.Conn`, and at most one `sql.Tx` per opaque session ID.
- Bind each session to its profile ID and database context. Serialize execution and transaction-control operations per session; reject profile/database/permission mismatches.
- Manual mode lazily opens a database session and starts a transaction on the first query. Commit/Rollback ends only the current transaction; the session can start a new one on the next query. Auto mode remains unchanged.
- Preserve the existing query policy gate. MySQL/PostgreSQL/SQLite use read-only transactions/connections when the editor is in read mode. SQL Server's driver rejects read-only `TxOptions`, so the existing application policy remains its write guard there.
- Prevent raw transaction-control SQL (`BEGIN`/`COMMIT`/`ROLLBACK`) from bypassing UI state in a managed manual session; show a clear instruction to use the toolbar controls.
- On tab close, ask before discarding an active transaction; closing a confirmed manual session always rolls back. Also close sessions on editor unmount and add an engine-side idle timeout as a crash/renderer-disconnect backstop.
- Surface Auto/Manual, idle/active/failed state, and commit/rollback buttons in the query toolbar. Keep all transaction state per tab.

## TDD and verification

1. Add failing tests for the shared session manager: owner binding, read-only enforcement, sequential queries in one transaction, commit, rollback, failed query recovery, and close rollback.
2. Add failing renderer tests for per-tab transaction state/action availability and mode transitions.
3. Implement typed port, HTTP, Electron IPC, adapter, and renderer paths. Implement each SQL adapter before changing the shared connector contract.
4. Add a desktop E2E using a temporary SQLite file: insert in Manual mode is invisible to a second connection before commit, visible after commit, and absent after rollback. Exercise close confirmation and capture a screenshot showing an active transaction.
5. Run Go tests, renderer test/lint/build, desktop build, and the isolated Electron E2E. Do not use personal or production DB data.

## Safety boundaries

- Auto remains the default and retains current behavior.
- Manual mode never auto-commits on tab close, connection loss, renderer shutdown, or engine shutdown; open transactions are rolled back.
- Destructive/write policy confirmations remain in force for every statement.
- No transaction operation is exposed for Redis/MongoDB.
