# Persistent query-console sessions and explicit transactions

## Problem and contract

Auto currently creates a new physical connection per statement, so SQL START
TRANSACTION succeeds but subsequent writes auto-commit on other connections.
The same path loses session settings and locks. MySQL additionally injects
CONNECTION_ID before each query, corrupting ROW_COUNT, and counts result rows
instead of affected rows for DML.

DataGrip documents a session as a wrapper over one connection and binds query
consoles to sessions:
https://www.jetbrains.com/help/datagrip/managing-connection-sessions.html
https://www.jetbrains.com/help/datagrip/query-consoles.html

Match the database-console behavior relevant to this incident: a console keeps
its connection in Auto and Manual, plain Auto DML commits normally, explicit SQL
transaction boundaries are honored, and session settings/locks survive separate
executions. Do not claim complete DataGrip UI parity from documentation alone.

## Implementation

- Keep a pinned sql.Conn per tab independently of transaction mode. Execute
  native transaction SQL on that connection so SQL boundaries and toolbar
  boundaries agree, without maintaining a stale sql.Tx around raw COMMIT.
- Auto does not begin/commit around user statements. Manual lazily begins a
  transaction. Honor BEGIN, COMMIT, ROLLBACK, savepoints, chain modifiers and
  MySQL implicit boundaries in session state. Never replay a query or silently
  reconnect a dead session.
- Configure read-only enforcement once when opening the connection. Cache server
  cancellation IDs there; do not insert diagnostics between user statements.
- Serialize execution/control/close, invalidate closed sessions, and explicitly
  rollback before closing. Retain owner/database/permission checks.
- Send engine transaction state in stream completion/error messages. UI creates
  sessions for Auto too, retains them across runs, and protects pending explicit
  transactions on tab/database/mode/disconnect operations.
- Use ExecContext/RowsAffected for non-result SQL in the existing one-shot path
  too. Keep policy gates and non-editor batch behavior unchanged.
- Update architecture/security docs for the connection-lifetime contract.

## TDD and verification

1. RED tests for persistent Auto connection state, explicit rollback/commit,
   SQL transaction classification/savepoints, close/expiration rollback and
   rejected stale sessions; renderer authoritative state/controls/lifecycle tests.
2. Implement shared manager and all four SQL adapters before changing the port.
3. Add permanent MySQL Electron E2E for the user's DELETE JOIN / revision flow,
   ROW_COUNT=1, time_zone, FOR UPDATE lock persistence, separate execution,
   plain Auto writes, tab isolation, SQL and toolbar boundaries, errors and close.
4. Run targeted Go/renderer tests, builds, existing transaction/lifecycle E2Es,
   and the MySQL E2E against a disposable local container. Use isolated metadata
   and user data; drop only owned e2e_* tables and remove the container afterward.

## Work boundaries

Preserve pre-existing working-tree edits. Integrate only this change through a
main-targeted PR. Installer releases remain a separate operation.

## Verification completed

- `pnpm build`: engine, renderer, and desktop builds passed.
- `go test ./engine/internal/...`: all packages passed.
- `go test -race ./engine/internal/adapters/sqlsession`: passed.
- `pnpm --filter renderer test`: 62 files / 460 tests passed on the latest main integration.
- `pnpm --filter desktop test`: 6 files / 32 tests passed.
- `pnpm --filter renderer lint`: no errors; three existing hook dependency warnings.
- Electron E2E: 18 passed across query-mysql-transactions, query-transactions,
  connection-session-lifecycle, query-multi-policy-resume,
  query-risk-confirmation, query-context, and query-tab-context-menu.
- MySQL 8.4.11 used a disposable container on 127.0.0.1:13306. SQLite used
  temporary files. Metadata and Electron user data were isolated. Owned e2e_*
  tables were dropped and the container was removed after verification.

The MySQL E2E covers the reported DELETE JOIN/revision flow in separate runs and
one script, external visibility before/after rollback and commit, session IDs,
time_zone, FOR UPDATE NOWAIT from a second connection, ROW_COUNT=1, affected
counts, tab isolation, SQL/toolbar boundaries, savepoints/chain/autocommit,
rollback after errors and tab close, lost connections without replay, and
discarding paused scripts when their transaction is resolved. SQLite additionally
covers outer SAVEPOINT release in Auto and Manual.

Only explicit schema-browser actions retain editable table previews; console
SELECTs always execute on their pinned connection. Read/write permission changes
may recreate an idle session, and pending transactions must first be resolved.
No procedure-body or dynamic-SQL inspection is performed; native DB rules,
including MySQL DDL implicit commits, remain in effect. DataGrip itself was not
launched: parity here means its documented per-console session contract and the
native SQL transaction behavior relevant to this report, verified on MySQL and
SQLite. PostgreSQL and SQL Server were compiled and covered by existing adapter
tests but were not connected to live servers for this change.
