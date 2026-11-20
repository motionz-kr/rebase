# GCP Cloud SQL connections (cloud-sql-proxy) and local MCP

Issue: https://github.com/motionz-kr/rebase/issues/231 (spec — the issue body is the authority)
Reference implementation: AWS SSM (#207, PR #208, `docs/superpowers/plans/2026-09-30-aws-ssm.md`)

## Scope

Add a `gcp_cloudsql` connection mode for MySQL, PostgreSQL and SQL Server. The engine
launches the installed `cloud-sql-proxy` (v2) as a child process on a free loopback port,
waits until it is ready, reuses it for concurrent requests, and cleans it up on profile
close, settings change and engine shutdown. Profiles store only the instance connection
name, auth mode, optional credentials-file *path*, Private IP flag and optional proxy
executable path. DB name/user/password stay where they are (password in OS Keychain).

Out of scope: Cloud SQL IAM DB auth (`--auto-iam-authn`), AlloyDB, PSC, impersonation,
embedding the Go connector.

## Global constraints (bind every task)

- Mode string: `gcp_cloudsql`. Profile JSON field: `gcpCloudSql`. Go type: `domain.GCPCloudSQLConfig`.
- `GCPCloudSQLConfig` JSON fields (exact): `instanceConnectionName`, `authMode` (omitempty;
  `""`/`gcloud` = default, `adc`, `credentials_file`), `credentialsFile` (omitempty),
  `privateIp` (bool, omitempty), `proxyPath` (omitempty).
- Never store key contents or tokens. Never forward proxy output to engine stdout/stderr
  (MCP stdio protocol must stay clean). User-facing errors are curated Korean messages;
  raw proxy output is never returned to the UI (it may contain tokens/paths).
- Launch argv directly, never through a shell.
- Existing SSM/SSH behaviour, validation messages and stored profiles must not change.
- Clean Architecture: `domain` imports no adapters; process code lives in an adapter package;
  `application` sees only `ports.TunnelManager`.
- TDD for pure logic: failing test first.
- Commits: small, one task per commit (or a few), message ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No push, no merge.
- Go module root is the repo root (`go.mod`); run Go tests as `go test ./engine/...`.
  Renderer tests: `pnpm --filter renderer test` (vitest). Desktop build: `pnpm --filter desktop build`.

## Verified facts about cloud-sql-proxy (v2.19.0, measured 2026-11-20)

- Startup logs (stderr/stdout): `Authorizing with gcloud user credentials`,
  `[<instance>] Listening on 127.0.0.1:<port>`,
  `The proxy has started successfully and is ready for new connections!`.
- The proxy is lazy: a wrong/nonexistent instance still reaches "ready". With
  `--run-connection-test` it then logs `Connection test started` and either
  `Connection test passed` or `Connection test failed` followed by a terminal error line such as
  `proxy server error: failed to get instance: refresh error: failed to get instance metadata (connection name = "x:y:z"): googleapi: Error 400: Project specified in the request is invalid., errorInvalidProject`
  and exits.
- Bad credentials file: `Error starting proxy: error initializing dialer: config error: open /nonexistent/key.json: no such file or directory` then
  `The proxy has encountered a terminal error: unable to start: ...` and exits.
- Flags used: `--gcloud-auth`, `--credentials-file <path>`, `--private-ip`, `--address 127.0.0.1`,
  `--port <n>`, `--run-connection-test`. ADC = no auth flag.
- On this machine the binary lives in a gcloud SDK dir (`.../google-cloud-sdk/bin/cloud-sql-proxy`)
  next to `gcloud`. `--gcloud-auth` needs `gcloud` reachable on the child's PATH.

## Tasks

### Task 1: Domain config and validation (TDD)

Files: new `engine/internal/domain/gcp_cloudsql.go`, `engine/internal/domain/gcp_cloudsql_test.go`;
edit `engine/internal/domain/connection.go` (add field `GCPCloudSQL *GCPCloudSQLConfig \`json:"gcpCloudSql,omitempty"\``
next to `SSM`/`SSH`, update the `ConnectionMode` comment) and the `ValidateConnectionRoute` switch in
`engine/internal/domain/ssm.go` (add `case "gcp_cloudsql": return p.validateGCPCloudSQLRoute()`).

Rules for `validateGCPCloudSQLRoute` (error messages exact):
- Driver must be `mysql`, `postgres` or `sqlserver` → else `Cloud SQL connections support MySQL, PostgreSQL and SQL Server`.
- Config non-nil and `InstanceConnectionName` matches
  `^([a-z][a-z0-9.\-]*[a-z0-9]:)?[a-z][a-z0-9\-]{4,28}[a-z0-9]:[a-z]+-[a-z]+[0-9]+:[a-z][a-z0-9\-]{0,97}$`
  → else `Cloud SQL requires an instance connection name (project:region:instance)`.
  Accept `my-project:asia-northeast3:cvi-db`, `example.com:my-project:us-central1:db1`.
  Reject empty, `badname`, `-p:asia-northeast3:db`, `My-Project:asia-northeast3:db`, values with spaces/newlines.
- `AuthMode` in `""`, `gcloud`, `adc`, `credentials_file` → else `unsupported Cloud SQL auth mode`.
- `credentials_file`: `CredentialsFile` must be an absolute path (`filepath.IsAbs`) with no `\r\n\x00`
  and not starting with `-` → else `Cloud SQL: absolute service account key file path is required`.
  For other auth modes a non-empty `CredentialsFile` is ignored by command building (do not reject).
- `ProxyPath` optional; if set must be absolute, no `\r\n\x00` → else `Cloud SQL: cloud-sql-proxy path must be absolute`.
- `TLSMode` must be `""`, `none` or `prefer` → else
  `Cloud SQL Proxy encrypts the connection; set TLS to none`. (The local hop to the proxy is plaintext.)
- Host/Port are NOT required. Add `func (p ConnectionProfile) UsesProxyManagedEndpoint() bool` returning
  true for SSM document destination OR `gcp_cloudsql`, and use it in `Validate()` instead of the two
  `!p.SSMUsesDocumentDestination()` checks. Keep `SSMUsesDocumentDestination` (still used elsewhere).
- Database name still required for relational drivers (unchanged rule).

Tests: table-driven for each rule above plus "existing ssm/ssh/direct cases still pass" (run the
whole domain package).

### Task 2: Persistence (migration + repository)

Files: new `engine/internal/adapters/sqlite/gcp_cloudsql_migration.go`; edit
`engine/internal/adapters/sqlite/sqlite_profile_repository.go`, its test, and
`engine/cmd/app-engine/main.go` (append after `sqlite.SSHProfileMigration`).

- Migration: `Version: 21`, `Name: "add_gcp_cloudsql_connection_route"`,
  SQL `ALTER TABLE connection_profiles ADD COLUMN gcp_cloudsql_config TEXT NOT NULL DEFAULT '';`,
  `Checksum: "profile-gcp-cloudsql-route-v1"`. First confirm 21 is unused anywhere in the engine.
- Repository: write `json.Marshal(p.GCPCloudSQL)` into `gcp_cloudsql_config` on create/update; read it
  in every SELECT and decode via `decodeGCPCloudSQL` mirroring `decodeSSM`/`decodeSSH`
  (empty string and `null` → nil; invalid JSON → error `invalid stored Cloud SQL configuration: ...`).
- Tests: round-trip a `gcp_cloudsql` profile; profiles saved before this migration (SSM, SSH, direct rows
  written with the old column set, then migration 21 applied) load unchanged with `GCPCloudSQL == nil`.
  Follow the existing SSM/SSH repository tests' setup.

### Task 3: Proxy command, executable discovery and error mapping (TDD)

New package `engine/internal/adapters/cloudsql` (doc comment: owns local cloud-sql-proxy process lifecycles).
Files: `command.go`, `command_test.go`, `discovery.go`, `discovery_test.go`.

- `proxyArgs(p domain.ConnectionProfile, localPort int) ([]string, error)`: require mode `gcp_cloudsql`
  (`Cloud SQL connection mode is required`), run `ValidateConnectionRoute`, port 1..65535
  (`invalid local proxy port`). Output order exactly:
  auth flags (`--gcloud-auth` for ""/gcloud; `--credentials-file`, `<path>` for credentials_file; nothing for adc),
  then `--private-ip` if set, then `--address`, `127.0.0.1`, `--port`, `<n>`, `--run-connection-test`,
  then the instance connection name as the final positional argument.
- `startupError(output string) error` → curated messages (match case-insensitively, first match wins, in this order):
  1. `unknown flag` → `Cloud SQL: cloud-sql-proxy v2 최신 버전이 필요합니다. gcloud components update 또는 재설치 후 다시 시도하세요`
  2. `reauth`, `invalid_grant`, `invalid_rapt`, `token has been expired`, `gcloud auth login` →
     `Cloud SQL: gcloud 로그인이 만료되었습니다. 터미널에서 gcloud auth login 을 실행하세요`
  3. `could not find default credentials` → `Cloud SQL: Application Default Credentials가 없습니다. gcloud auth application-default login 을 실행하거나 인증 방식을 바꾸세요`
  4. `credentials file`/`credentials-file` together with `no such file` or `config error` →
     `Cloud SQL: 서비스 계정 키 파일을 읽지 못했습니다. 경로와 권한을 확인하세요`
  5. `error 403`, `notauthorized`, `not authorized`, `permission`, `cloudsql.instances.get` →
     `Cloud SQL: IAM 권한이 부족합니다. 대상 프로젝트에 roles/cloudsql.client 권한이 필요합니다`
  6. `error 404`, `does not exist`, `not found`, `errorinvalidproject`, `invalid project`, `instance does not exist` →
     `Cloud SQL: 인스턴스를 찾을 수 없습니다. 인스턴스 연결 이름(project:region:instance)을 확인하세요`
  7. `private ip`, `no private ip`, `does not have ip of type "private"` →
     `Cloud SQL: 인스턴스에 Private IP가 없거나 이 네트워크에서 접근할 수 없습니다. Private IP 설정을 확인하세요`
  8. default → `Cloud SQL Proxy를 시작하지 못했습니다. gcloud 인증, 인스턴스 이름과 네트워크 설정을 확인하세요`
  Tests use the real log lines quoted in "Verified facts" plus one synthetic line per branch, and assert no raw
  output (e.g. a fake token `secret-e2e-token`) ever appears in the returned message.
- `findProxy(explicit string) (string, error)` and `findGcloudDir() string` in `discovery.go`, with injectable
  `lookPath`/`homeDir`/`stat` for tests (struct `finder` with function fields; package-level default).
  - Explicit path set → must exist and be executable, else error
    `Cloud SQL: 지정한 cloud-sql-proxy 경로를 실행할 수 없습니다`. No fallback when explicit path is set.
  - Otherwise search, in order: `exec.LookPath("cloud-sql-proxy")`; then the dir of `gcloud` found on PATH
    (resolve symlinks with `filepath.EvalSymlinks`) ; then dirs `/opt/homebrew/bin`, `/usr/local/bin`,
    `~/.local/bin`, `~/google-cloud-sdk/bin`, `/opt/homebrew/share/google-cloud-sdk/bin`,
    `/usr/local/share/google-cloud-sdk/bin`, `/opt/homebrew/Caskroom/google-cloud-sdk/latest/google-cloud-sdk/bin`.
    Not found → `Cloud SQL: cloud-sql-proxy를 찾을 수 없습니다. gcloud components install cloud-sql-proxy 또는 brew install cloud-sql-proxy 로 설치하거나 실행 파일 경로를 지정하세요`.
  - `findGcloudDir` uses the same search for `gcloud` and returns its directory (`""` if none).
  - On Windows also try the `.exe` suffix (LookPath handles PATH; the fixed dirs are POSIX-only — skip them on windows).

### Task 4: Proxy manager lifecycle and tunnel wiring

Files: `engine/internal/adapters/cloudsql/manager.go`, `manager_test.go`, `lifecycle_unix_test.go`,
new `engine/internal/adapters/procgroup/{procgroup_unix.go,procgroup_windows.go}`; edit
`engine/internal/adapters/ssm/{manager.go,process_unix.go,process_windows.go}` (remove helpers, call procgroup)
and `engine/internal/adapters/tunnel/manager.go`.

Model it on `engine/internal/adapters/ssm/manager.go` (read it fully first) but WITHOUT remote session
cleanup (the proxy is purely local). Do not copy the process-group helpers: first move
`configureProcess`/`terminateProcessTree`/`killProcessTree` from `ssm/process_unix.go` and
`ssm/process_windows.go` into a new package `engine/internal/adapters/procgroup` (exported as
`Configure`, `Terminate`, `Kill`, same build tags), switch ssm to it (mechanical; no other ssm change; all
ssm tests must still pass), and use it from cloudsql. Then there are no cloudsql `process_*.go` files.
- `NewManager()`, `ResolveEndpoint(ctx, p)`, `CloseProfile(id)`, `Close()`; same coalescing/entry map,
  30s start timeout detached from the request ctx, stale/exited proxy replaced on next call, closed manager
  error `Cloud SQL proxy manager is closed`.
- Tunnel key includes profile ID, instance name, auth mode, credentials file, private IP and proxy path, so
  a settings change starts a fresh proxy.
- `start`: find proxy (Task 3), pick a free port via `net.Listen("tcp","127.0.0.1:0")`, build args, child env =
  `os.Environ()` plus `PATH=<proxyDir>[:<gcloudDir>]:<original PATH>`; process group setup and
  SIGTERM→1s→SIGKILL tree stop exactly like SSM (via `procgroup`).
  Output buffer bounded at 16 KiB, never forwarded. Ready when output contains `Connection test passed`;
  then dial-check the port like SSM. Process exits before ready → `startupError(output)`. Timeout/cancel →
  `Cloud SQL Proxy 준비 시간이 초과되었거나 취소되었습니다. gcloud 인증과 인스턴스 상태를 확인하세요`.
  Exec start failure → `Cloud SQL: cloud-sql-proxy를 실행하지 못했습니다. 설치 경로와 실행 권한을 확인하세요`.
  Ready but port never accepts → `Cloud SQL: 로컬 프록시 포트를 열지 못했습니다`.
  Proxy died after ready (on reuse) → `Cloud SQL Proxy 연결이 종료되었습니다. 다시 연결하세요`.
- Tests (with injected `lookPath`/`command` like ssm `manager_test.go`, and a fake proxy built as a small Go/shell
  helper in `lifecycle_unix_test.go` that prints the real log lines and listens on `--port`):
  argv/env reaching the child, coalescing of concurrent calls (one process), reuse, restart after exit,
  startup failure mapping, timeout/cancel cleanup (no orphan process), CloseProfile isolation between two
  profiles, Close() stops all and rejects new calls, settings change → new process.
- `tunnel.Manager`: add `cloudsql *cloudsql.Manager`, route `case "gcp_cloudsql"`, include it in
  `CloseProfile` and `Close`.

### Task 5: SQL Server endpoint routing + routing contract

Files: `engine/internal/adapters/sqlserver/sqlserver_connector.go` (+ test), every constructor call site
(`engine/internal/transport/http/{query,profile,agent,introspection,mcp_write}.go`,
`engine/cmd/app-engine/main.go` lines that call `sqlserver.NewSQLServerConnector()`),
`engine/internal/adapters/ssm_routing_contract_test.go`.

- `NewSQLServerConnector(resolvers ...ports.ConnectionEndpointResolver)` exactly like
  `postgres.NewPostgreSQLConnector`. Before building the DSN in every connection-opening path (including the
  query-session path), resolve the endpoint when a resolver is set; if no resolver and mode is not
  direct/empty → `connection endpoint resolver is unavailable`. Thread `ctx` into `connect` (all ~16 callers
  already have a ctx). Pass the `ConnectionService` at every call site that passes it to mysql/postgres.
- Contract test: extend modes to `gcp_cloudsql` and drivers to include `sqlserver` for `gcp_cloudsql` only
  (ssm/ssh stay mysql+postgres). Profile fixture adds `GCPCloudSQL: &domain.GCPCloudSQLConfig{InstanceConnectionName: "my-project:asia-northeast3:db1"}`
  and `TLSMode` none. Every listed operation must return the resolver error without dialing.

### Task 6: Renderer form and list

Files: `apps/renderer/src/lib/connectionRoute.ts` (+ `.test.ts`), `apps/renderer/src/App.tsx`,
`apps/renderer/src/global.d.ts`, `apps/renderer/src/App.css` if needed.

- Types: `ConnectionMode = 'direct' | 'ssm' | 'ssh' | 'gcp_cloudsql'`; `GCPCloudSQLConfig { instanceConnectionName: string;
  authMode?: 'gcloud' | 'adc' | 'credentials_file'; credentialsFile?: string; privateIp?: boolean; proxyPath?: string }`.
- `connectionRouteFromForm(driver, mode, ssm, ssh?, gcp?)` returns `{ connectionMode, ssm?, ssh?, gcpCloudSql? }`.
  `gcp_cloudsql` only for mysql/postgres/sqlserver, else direct. Trim strings; omit empty optional fields;
  omit `authMode` when `gcloud`; include `credentialsFile` only for `credentials_file`; `privateIp` only when true.
  Other modes return `gcpCloudSql: undefined`. Vitest first (RED), then implement.
- UI: route select gets `<option value="gcp_cloudsql">GCP Cloud SQL (cloud-sql-proxy)</option>` (shown for
  mysql/postgres/sqlserver). Fieldset (reuse `ssm-settings` styles) with ids `gcp-instance`
  (label `인스턴스 연결 이름`, placeholder `project:region:instance`, required), `gcp-auth-mode` select
  (`gcloud 사용자 로그인 (기본)` / `Application Default Credentials` / `서비스 계정 키 파일`), `gcp-credentials-file`
  (shown only for credentials_file, required then, placeholder `/Users/me/keys/sa.json`), `gcp-private-ip` checkbox
  (`Private IP로 연결`), `gcp-proxy-path` (label `cloud-sql-proxy 경로 (선택)`, placeholder `자동 탐색`).
  Notes: `Host·Port는 입력하지 않습니다. 엔진이 cloud-sql-proxy를 띄우고 로컬 포트를 자동으로 잡습니다.` and
  `cloud-sql-proxy v2와 gcloud 로그인(또는 선택한 인증)이 필요합니다. 키 파일은 경로만 저장합니다.`
  Hide Host/Port inputs in this mode (same mechanism as SSM document destination) and send host `127.0.0.1`,
  port = driver default (3306/5432/1433) so non-route code paths that display host/port stay sane.
  When the mode is switched to gcp_cloudsql set TLS to `none`.
  Edit-load maps `p.connectionMode === 'gcp_cloudsql'` and `p.gcpCloudSql`. Reset paths clear the gcp state.
  `connectionTestSettings` includes the gcp state. Connection list label: `Cloud SQL · <instanceConnectionName>`.
- Run `pnpm --filter renderer test` and `pnpm --filter renderer build`; `tsc` must be clean.

### Task 7: Electron E2E with a fake proxy + MCP stdio

File: new `apps/desktop/e2e/gcp-cloudsql.spec.ts` (model on `apps/desktop/e2e/ssm.spec.ts`; read it and
`fixtures.ts` first). Adjust `fixtures.ts` only if an env passthrough is needed.

- Fake `cloud-sql-proxy` (node shebang script in a temp dir, POSIX only, skip on win32) that parses
  `--port`, `--address`, auth flags, `--private-ip`, `--run-connection-test` and the instance name; records each
  launch to a jsonl log; prints the real startup lines; for instance `e2e-proj:asia-northeast3:expired`
  prints `failed to refresh token: oauth2: "invalid_grant" "Reauthentication failed. Please run gcloud auth login" secret-e2e-token` and exits 1;
  `e2e-proj:asia-northeast3:denied` prints a 403 `NOT_AUTHORIZED ... cloudsql.instances.get` line and exits;
  `e2e-proj:asia-northeast3:missing` prints the real Error 400 errorInvalidProject line and exits;
  otherwise listens and TCP-forwards to the local DB, prints `Connection test passed`, and exits 0 on SIGTERM.
  Expose it via the engine child's PATH (same way ssm.spec does).
- Flows (local MySQL `127.0.0.1:3306` per `dbProbe.ts`; skip gracefully if closed. If env
  `E2E_POSTGRES_PORT` is reachable, run the same happy path for PostgreSQL too):
  1. Create a Cloud SQL profile in the UI, Test succeeds, save, list shows `Cloud SQL · e2e-proj:asia-northeast3:db1`,
     run `SELECT 1` → result; the log shows exactly one proxy launch with `--gcloud-auth`, a non-3306 port,
     `--run-connection-test`, and the instance name last.
  2. Concurrent operations reuse one proxy; closing the app leaves no fake proxy process alive.
  3. Error profiles show the curated messages (gcloud login expired / IAM / instance not found) and never the
     raw `secret-e2e-token`.
  4. Stored SSM/SSH profiles created earlier in the same isolated metadata DB still load and display.
  5. MCP stdio: run the engine binary in MCP mode for the saved profile (as ssm.spec does) with the fake PATH,
     call a read tool, get a row back; MCP stdout contains only JSON-RPC lines.
- Rebuild before running: `pnpm build:engine`, `pnpm --filter desktop build`, `pnpm --filter renderer build`, then
  `pnpm --filter desktop exec playwright test e2e/gcp-cloudsql.spec.ts e2e/ssm.spec.ts e2e/ssh.spec.ts`.

### Task 8: Docs

- New `docs/gcp-cloudsql-connections.md` (Korean, same structure as `docs/ssm-connections.md`): 준비
  (cloud-sql-proxy v2 설치, gcloud auth login, roles/cloudsql.client), 연결 설정 단계 (CVI 예:
  `cs_intelligence`, PostgreSQL 15), 인증 방식 3가지, Private IP, 동작과 수명, 오류 안내 표, MCP, 별도 범위.
- Update `docs/architecture.md`, `docs/security.md`, `docs/mcp-server.md` where SSM is described (add Cloud SQL
  alongside; key path only, no key content; proxy logs never forwarded).
- Append a `## Verification (2026-11-20)` section to this plan with the commands actually run and results.

## Execution notes

- Controller (Opus) plans and supervises; implementers are Sonnet subagents; task and final reviews are run with
  the Codex CLI (`codex exec`, read-only sandbox) against the review package.
- No push/merge without the user's go-ahead.

## Verification (2026-11-20)

Executed with Go 1.25.7 from `/tmp/gotc` (no system Go). Facts from the per-task reports and the SDD ledger.

- `go test ./engine/...` all ok after Tasks 1, 2, 3, 5 (controller re-ran after Task 5: all ok);
  `go vet` clean, `GOOS=windows go vet` clean for the cloudsql adapter.
- `go test -race ./engine/internal/adapters/cloudsql/... ./engine/internal/adapters/ssm/... ./engine/internal/adapters/procgroup/...`:
  cloudsql ok, ssm ok (Task 4). Windows lifecycle tests were not run (no Windows host).
- `pnpm --filter renderer test`: 62 files / 467 tests passed (Task 6); renderer build and tsc clean.
- Build: `pnpm build:engine`, `pnpm --filter renderer build`, `pnpm --filter desktop build` all OK.
- E2E: `E2E_MYSQL_DATABASE=mysql E2E_POSTGRES_PORT=55432 pnpm --filter desktop exec playwright test e2e/gcp-cloudsql.spec.ts e2e/ssh.spec.ts`
  -> 6 passed, 1 skipped (ssh postgres); `gcp-cloudsql.spec.ts` 4/4 passed. Local MySQL had no `devdb`, so MySQL flows
  used `mysql`; PostgreSQL 15 ran in a disposable container on port 55432.
- `e2e/ssm.spec.ts` MySQL tests fail ("invalid connection" on SELECT 75 after closing a broken manual session). The
  same failure reproduces with an engine built from base `fe24728`, so it is pre-existing and not fixed on this branch.
- E2E Keychain cleanup: spec removes the secrets it creates; `security dump-keychain` count 65 before and after, no new entries.
- **Not done:** live verification against a real GCP Cloud SQL instance (real cloud-sql-proxy + GCP credentials).
  The E2E uses a fake proxy; the readiness/error handling follows the behaviour measured with cloud-sql-proxy v2.19.0.
- Rulings recorded in the ledger: SQL Server included; shared `procgroup` helpers; separate cloudsql/ssm managers;
  two proxy launches (unsaved Test + saved profile) in E2E instead of one.
