# Query tab session recovery after a lost DB connection

Issue: https://github.com/motionz-kr/rebase/issues/234 (spec — binding)
Background: `8be3ca0` pinned a connection per query tab and made a lost session fail closed
(`docs/architecture.md` "A lost/expired session fails explicitly and is never silently reopened or replayed").

## Root cause (investigated 2026-11-20)

- `engine/internal/adapters/sqlsession/manager.go` `session.complete` marks a session closed only for
  `sql.ErrConnDone` / `driver.ErrBadConn`. go-sql-driver/mysql reports a dropped connection as
  `mysql.ErrInvalidConn` ("invalid connection"), so MySQL sessions are never marked lost and every later run
  fails with the raw driver error. PostgreSQL reports `driver: bad connection` and is marked closed, but then
  returns `ErrClosed` forever.
- The renderer (`apps/renderer/src/components/QueryEditor.tsx`) keeps the dead session id in
  `transactionSessionsRef`/`transactionSessionId`; nothing discards it, so the tab only recovers after a profile
  disconnect/reconnect.
- Effect: `apps/desktop/e2e/ssm.spec.ts` local DB paths fail at `SELECT 75` (after the spec kills the tunnel);
  tabs also break after a profile update (tunnel restarted) or a Cloud SQL proxy restart.

## Behaviour to build (keeps "no replay, no silent reconnect")

- A session whose connection is lost while **idle** (no open transaction): the failing run reports a curated
  error; the engine reports state `lost`; the renderer discards that session; the **next** user run opens a new
  session. The failed statement is never re-executed.
- A session whose connection is lost **inside a transaction**: state `lost_transaction`; every run keeps failing
  with a curated message (as today); Commit is refused; Rollback succeeds without SQL (the server already
  aborted the transaction), after which the state is `lost`, the renderer discards the session and shows the
  notice `연결이 끊겨 트랜잭션이 취소되었습니다`, and the next run opens a new session.

## Global constraints (bind every task)

- Never replay a failed statement and never reconnect inside a run; only a new user action opens a new session.
- Driver-specific errors stay inside adapters (AGENTS.md §2). `sqlsession` is driver-neutral; adapters pass a
  classifier.
- Exact state strings: `idle`, `active`, `failed`, `lost`, `lost_transaction`.
- Exact curated messages (engine, Korean):
  - idle loss: `DB 연결이 끊겼습니다. 이 문장의 결과는 확인되지 않았습니다. 다시 실행하면 새 연결로 실행합니다.`
  - loss in transaction (every run, and Commit): `트랜잭션 중 DB 연결이 끊겼습니다. 커밋되지 않은 변경은 서버에서 취소됩니다. Rollback 후 다시 실행하세요.`
  - loss while a COMMIT (SQL `COMMIT`/`END`/`COMMIT AND CHAIN` or toolbar Commit) is executing — outcome unknown, state
    `lost` (not `lost_transaction`): `커밋 중 DB 연결이 끊겨 커밋 여부를 확인할 수 없습니다. 새 연결에서 데이터를 확인한 뒤 진행하세요.`
- Renderer notice after rolling back a lost transaction: `연결이 끊겨 트랜잭션이 취소되었습니다`.
- Status labels (renderer): `lost` → `연결 끊김`, `lost_transaction` → `연결 끊김 · 롤백 필요`.
- Existing transaction semantics, policy gates and other tests must not change behaviour.
- TDD for pure logic. Go: `PATH=/tmp/gotc/go/bin:$PATH` from the repo root. Commits end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push/merge.

## Tasks

### Task 1: Engine — classify lost connections and report lost states

Files: `engine/internal/adapters/sqlsession/manager.go` (+ `manager_test.go`), `engine/internal/adapters/mysql/mysql_adapter.go`
(and postgres/sqlserver/sqlite adapters only if needed to pass the classifier), `engine/internal/transport/http/query.go`
(+ test).

- `sqlsession.Options` gains a connection-loss classifier (e.g. `IsConnectionLost func(error) bool`); the manager
  treats `sql.ErrConnDone`, `driver.ErrBadConn` and the classifier's matches as loss. MySQL adapter passes a
  classifier matching `mysql.ErrInvalidConn` (and anything else the driver uses for a dropped connection — verify
  against the real driver with a test that kills the server connection, e.g. via `KILL CONNECTION` in the existing
  integration style, or a closed-listener unit test).
- On loss: mark the session closed and remember whether a transaction was active.
  `State` returns `lost` (closed, no active transaction) or `lost_transaction` (closed during a transaction);
  otherwise unchanged (`failed`, `active`, `idle`).
- `Commit` on `lost_transaction` → error with the exact loss-in-transaction message, no SQL.
  `Rollback` on `lost_transaction` → no SQL, clears the transaction flags, returns nil; state becomes `lost`.
  Queries on a lost session never touch the connection (return the matching curated error).
- Transport (`query.go` stream): when the session state after execution is `lost`/`lost_transaction`, send the exact
  curated message instead of the raw driver error, with `transactionState`. The `rollback`/`commit` control responses
  (`query.go` ~433) include the resulting `transactionState`.
- Tests: manager unit tests for each transition (idle loss, loss in tx, commit refused, rollback → lost, no SQL issued
  on a lost session), classifier wiring for MySQL, transport messages/state. Run `go test ./engine/...` and
  `go test -tags=integration -run '^$' ./engine/...` compile check.

### Task 2: Renderer — discard lost sessions

Files: `apps/renderer/src/lib/queryTransaction.ts` (+ test), `apps/renderer/src/components/QueryEditor.tsx`,
`apps/renderer/src/global.d.ts`, preload/main typings only if the response shape needs it.

- `QueryTransactionState` adds `lost` and `lost_transaction`; controls: `lost_transaction` enables Rollback only;
  labels per Global constraints. TDD in `queryTransaction.test.ts`.
- When a run's `error`/`done` message carries `transactionState: 'lost'`: close the session best-effort (ignore errors),
  clear `transactionSessionsRef`/`transactionSessionId`/permission cache, set the tab state `idle`, keep the curated error
  visible. The next run goes through `ensureTransactionSession` and opens a new session.
- `lost_transaction`: show the state/label; Rollback calls the engine; when the response state is `lost`, discard the
  session as above and set `transactionNotice` to the exact notice.
- Disconnect/tab-close/mode-change guards treat `lost_transaction` like `failed` (pending work to resolve) and `lost` as
  nothing pending.
- `pnpm --filter renderer test` and `pnpm --filter renderer build` clean.

### Task 3: E2E, docs and verification

- `apps/desktop/e2e/ssm.spec.ts` (~243–247): after the tunnel kill and manual-session close, the UI tab's `SELECT 75`
  first shows the idle-loss message; running it again returns `75` on a new tunnel (`records()` length 3). Keep the
  rest of the flow.
- `apps/desktop/e2e/query-mysql-transactions.spec.ts` "a lost session fails without reconnecting or replaying writes":
  keep both failing runs and the snapshot; then assert the status label `연결 끊김 · 롤백 필요`, click Rollback, assert
  the notice, run `SELECT 1` successfully, snapshot unchanged.
- `apps/desktop/e2e/gcp-cloudsql.spec.ts` (~274): replace the reconnect workaround after saving with the real recovery
  (first run shows the idle-loss message, rerun succeeds on the new proxy); keep launch-count assertions consistent.
- Update `docs/architecture.md` (connection-lifetime contract) and `docs/security.md` where the lost-session rule is
  stated; append `## Verification` to this plan with commands and results.
- Run: renderer test/build, `pnpm build` (with Go on PATH), and
  `pnpm --filter desktop exec playwright test e2e/ssm.spec.ts e2e/ssh.spec.ts e2e/gcp-cloudsql.spec.ts e2e/query-mysql-transactions.spec.ts e2e/query-transactions.spec.ts e2e/connection-session-lifecycle.spec.ts`
  with `E2E_MYSQL_DATABASE=mysql` and the disposable PostgreSQL on 55432 for every PG env var
  (`E2E_POSTGRES_PORT`, `E2E_SSM_POSTGRES_PORT`, `E2E_SSH_POSTGRES_PORT`, passwords `e2epass`). `ssm.spec.ts` must be 6/6.

## Execution notes

Controller (Opus) plans/supervises; Sonnet implements; Codex (`codex exec -s read-only`, stdin closed) reviews each task
and the final branch. Never write to non-disposable DBs; E2E writes only to `e2e_*` tables they create and drop.
