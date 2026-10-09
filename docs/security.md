# Security

## 기본 원칙

이 앱은 사용자의 database credential과 임의 query 실행 권한을 다룬다. 따라서 일반 desktop app보다 보수적인 보안 설계가 필요하다.

기본 원칙:

- secret은 평문 파일이나 SQLite에 저장하지 않는다.
- renderer는 DB credential에 직접 접근하지 않는다.
- renderer는 DB driver를 직접 호출하지 않는다.
- local engine API는 per-launch token으로 보호한다.
- destructive query는 policy layer를 통과해야 한다.
- read-only mode는 앱의 query classifier만 믿지 않고 DB 세션의 read-only 강제 기능을 함께 사용한다.
- MCP 요청도 일반 UI 요청과 동일한 policy를 통과해야 한다.

## Secret Storage

SQLite에는 `secretRef`만 저장한다.

저장 가능:

- connection profile id
- host
- port
- database
- username
- driver
- SSL option metadata
- secret reference key

저장 금지:

- password
- access token
- private key
- client certificate private key
- cloud refresh token

Secret은 OS keychain에 저장한다.

- macOS: Keychain
- Windows: Credential Manager

Connection profile에는 secret 값 대신 Keychain 항목을 가리키는 `secret_ref`만 둔다. 편집 폼은 이 참조를 받지 않으며 engine이 저장된 값을 보존한다. 과거 버전에서 참조가 비워진 경우에는 기존의 `secret-<profile id>` 항목을 찾아 복구한다. 항목이 실제로 없으면 passwordless 연결을 위해 빈 비밀번호를 허용하지만, Keychain 접근 오류는 빈 비밀번호로 바꾸지 않고 호출자에게 전달한다.

## AWS SSM credentials and process boundary

SSM profile metadata contains AWS profile name, region, EC2 instance ID and
optional document name/destination mode, never credential values.
AWS CLI resolves credentials from the user's existing credential chain/SSO;
Rebase does not store AWS access keys or SSO tokens. DB passwords retain the
existing Keychain boundary. Shell interpolation is not used: region, instance
and destination parameters are validated and passed as argv/JSON.
Custom document names follow the StartSession API pattern and cannot begin with
an option prefix. Document-owned destinations send only `localPortNumber`; no
arbitrary shell command or free-form parameter map is accepted. The selected
document must provide a port forwarding session and honor the allocated port.
The adapter exposes only loopback endpoints after readiness, bounds its output
buffer, converts CLI output to curated errors and never forwards CLI logs to
renderer/MCP stdout or activity storage. An SSM error never falls back to a
direct DB connection or replays SQL. Existing MCP/query policies still apply.
The adapter retains the first complete SessionId from the plugin's startup
output in memory and explicitly terminates only that owned session, using the
original AWS profile and region. It never enumerates or bulk-terminates sessions.
Cleanup has an independent, bounded context; failed termination emits a curated
stderr warning without CLI output. IAM must allow `ssm:TerminateSession` for the
caller's own sessions. Hard process termination or unavailable AWS credentials/
network can still leave remote sessions requiring operator cleanup.

SSM transport does not introduce IAM DB authentication or stronger DB certificate
verification. See [SSM connections](ssm-connections.md) for supported scope.

## SSH key references and host verification

SSH profiles store only bastion host/port/user and user-selected identity/known_hosts
file paths in SQLite. Private key contents never enter profile JSON, renderer, logs
or MCP. The engine reads an unencrypted PEM/OpenSSH identity at connection time.
Encrypted keys and password/agent authentication are outside this initial scope.
Host authentication uses OpenSSH known_hosts (default ~/.ssh/known_hosts); unknown,
changed and revoked host keys fail closed. There is no automatic host-key acceptance.
The native SSH adapter opens only loopback listeners after authenticated handshake
and destination reachability checks, never starts a shell or accepts SSH commands.
Errors are curated without raw SSH/file contents. Profile changes/deletion and engine
shutdown close owned clients, listeners and sockets. Failed SSH routing cannot fall
back to direct DB access. DB TLS and existing MCP/query policies remain in force.

The `pickSSHFile` preload API accepts only identity/known-hosts picker categories;
Electron returns the user-selected path, without reading the file or accepting a
renderer-specified filesystem read. Security review of this boundary confirms that
no new filesystem content or secret retrieval API is exposed.
See [SSH connections](ssh-connections.md).

## Renderer Security

Electron renderer는 제한된 preload API만 사용한다.

필수 설정:

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`를 목표로 한다.
- preload는 필요한 API만 `contextBridge`로 노출한다.

Renderer에 노출하지 않는 것:

- DB password
- local engine auth token
- raw connection string
- keychain API
- filesystem secret path (사용자가 선택한 SSH identity/known_hosts 경로 메타데이터는 예외; 파일 본문은 노출하지 않음)

## Local Engine API Security

Go local engine은 local API를 제공한다.

원칙:

- `127.0.0.1`에만 bind한다.
- random available port를 사용한다.
- 앱 실행마다 새로운 auth token을 생성한다.
- token은 Electron main process가 보관한다.
- renderer는 typed preload API를 통해서만 요청한다.
- preload는 HTTP client 역할을 하지 않고 Electron main process로 IPC만 전달한다.
- CORS는 renderer origin만 허용한다.

## Query Policy

Query 실행은 policy layer를 통과해야 한다.

초기 정책:

- read-only mode에서는 write query를 기본 차단하되, 사용자가 위험 분석 대화상자에서 명시적으로 실행을 승인한 현재 쿼리에 한해 허용한다. 연결 프로필 자체가 read-only로 고정된 경우에는 이 예외를 허용하지 않는다.
- 연결 프로필의 read-only는 해당 연결의 모든 쿼리탭(client), 배치 실행, 테이블 편집 및 DDL 경로에 적용되는 hard guard다.
- 쿼리탭의 Read-only/Write 선택은 탭별 상태이며, 같은 연결의 다른 쿼리탭이나 다른 연결 프로필의 상태를 공유하지 않는다.
- 수동 트랜잭션 세션은 쿼리탭별로 소유하고, 세션을 닫을 때 미커밋 변경은 rollback한다.
- destructive query는 confirmation 없이 실행하지 않는다.
- query timeout 기본값을 둔다.
- result row limit 기본값을 둔다.
- query history에는 secret을 저장하지 않는다.
- PostgreSQL read-only mode에서는 transaction 또는 session 수준의 read-only 강제를 사용한다.
- MySQL read-only mode에서는 session transaction read-only 설정을 사용한다.

Destructive query 예시:

- `DROP`
- `TRUNCATE`
- `DELETE` without safe condition
- `ALTER`
- `CREATE USER`
- `GRANT`
- `REVOKE`

SQL parsing은 완벽하지 않을 수 있으므로 앱의 분류는 advisory gate로 취급한다. 확정적으로 read-only라고 판단할 수 없는 query는 confirmation 또는 read-only DB session을 요구한다. `SELECT 1; DROP TABLE x` 같은 multi-statement와 dialect별 statement split은 파서만으로 신뢰하지 않는다.

## Redis Safety

Redis는 keyspace 전체 탐색과 삭제가 위험할 수 있다.

원칙:

- `KEYS *`를 사용하지 않는다.
- `SCAN` 기반 pagination을 사용한다.
- delete는 confirmation을 요구한다.
- bulk delete는 MVP 범위에서 제외한다.
- 큰 value는 preview limit을 적용한다.

## MCP Security

MCP server/client 기능은 DB credential에 직접 접근하지 않는다.

현재 흐름:

```text
MCP Request
  -> MCP Adapter
  -> PolicyService
  -> QueryService / RedisService
  -> Connector Port
```

MCP 원칙:

- LLM 클라이언트와 MCP 도구 인자는 DB 비밀번호를 받지 않는다. 로컬 엔진이
  연결에 필요한 값을 OS Keychain에서 읽어 커넥터와 시크릿 가림 처리에 쓴다.
- MCP 클라이언트는 단일 로컬 stdio 서버에 연결한다. 서버는 MCP가 켜진
  연결 프로필만 노출하고, 각 도구 호출은 선택한 프로필의 MCP 활성화 여부와
  해당 프로필의 엔진 policy를 통과한다.
- stdio 실행 인자는 bearer 인증 토큰이 아니다. 실제 권한 경계는 프로필별
  MCP 노출 설정, DB/schema/table allowlist, read-only 및 write policy다.
- MCP read-only tool results are returned in full, including row values and
  diagnostic output such as `EXPLAIN`; this is required for the connected local
  AI client to perform useful analysis.
- MCP의 write 경로는 연결별로 기본 비활성화한다. 승인 모드에서는
  `propose_write`가 원문 SQL을 local SQLite proposal로 저장하고, Rebase UI의
  명시적 승인 이후에만 엔진이 그 원문을 실행한다. 사용자가 연결별
  `full_access`를 명시적으로 선택한 경우에만 `execute_write`가 쓰기를 즉시
  실행한다. 두 모드 모두 연결의 읽기 전용 설정과 MCP
  database/schema/table 범위를 엔진에서 강제한다.
- 통합 MCP 프로세스는 모든 PC의 데이터베이스 후보 검색 도구를 제공한다.
  검색은 알려진 DB 기본 포트의 loopback 연결 확인과 현재 Docker context의
  로컬 publish 포트 목록만 사용한다. 원격 Docker context와 임의 네트워크
  탐색은 제외하고, 컨테이너 환경 변수와 자격 증명은 읽지 않는다.
- MCP 연결 관리 도구는 검색 결과의 후보 ID에 연결된 create/update 제안만
  저장한다. 호출자가 host/port를 지정할 수 없고 endpoint는 현재 검색 결과에
  묶인다. 비밀번호, secret reference, connection URI, MCP 노출·쓰기 정책·허용
  목록 필드는 제안에 없으며 호출 인자로도 받을 수 없다. Rebase UI에서 변경
  내용을 검토하고 비밀번호를 입력한 뒤
  연결 테스트와 저장을 거쳐야 적용된다. 새 프로필은 MCP 비노출 및 쓰기 금지로
  시작하고, 수정 제안은 기존 프로필 권한을 유지한다.
- 통합 MCP 프로세스는 호출마다 최신 MCP 사용 프로필과 정책을 다시 읽는다.
  클라이언트가 도구 목록을 캐시해도 프로필 노출·쓰기 권한은 엔진의 최신
  프로필 상태로 검사하며, 새 프로필의 시크릿도 결과 반환 전에 다시 가린다.
- 활성화된 경우 database/schema/table exact allowlist가 엔진에서 강제된다.
- allowlist가 활성화된 상태에서 파싱할 수 없는 `FROM`/`JOIN` 참조는 거부한다.
- MCP 활동 기록에는 방향, 이벤트, 도구명, 상태, 실행 시간, 실행된 SQL, 안전한 오류 요약을 남긴다.
- 실행 SQL은 연결 비밀번호 등 등록된 secret을 `[redacted]`로 치환한 뒤 저장한다. token, header,
  environment variable은 MCP 활동 기록에 저장하지 않는다.

## Audit Log

MCP 활동은 local SQLite의 `mcp_activity_events`에 저장하고, 승인 대기 write는
`mcp_write_proposals`에 저장한다. MCP 연결 create/update 요청은 비밀이 없는
`mcp_connection_proposals`에 저장하며 Rebase에서 거부하거나 연결 저장을 마친 뒤
완료 처리한다. Team 기능이 추가되면
workspace/user 권한과 audit log를 별도 모델로 분리한다.

기록 후보:

- user id
- workspace id
- connection id
- executed SQL (registered secrets redacted)
- query type
- execution time
- result status
- error category

기록 금지:

- password
- token
- private key
- secret이 포함된 raw query parameter (secret redaction 이전 값)

## 보안 리뷰가 필요한 변경

아래 변경은 반드시 별도 보안 리뷰가 필요하다.

- secret 저장 방식 변경
- renderer API 추가
- local engine API 인증 방식 변경
- MCP 기능 추가
- cloud sync 추가
- destructive query policy 변경
- team permission 변경
