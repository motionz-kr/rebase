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
- filesystem secret path

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

- read-only mode에서는 write query를 차단한다.
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

MCP는 장기 확장 기능이다. MCP가 추가되어도 DB credential에 직접 접근하면 안 된다.

권장 흐름:

```text
MCP Request
  -> MCP Adapter
  -> PolicyService
  -> QueryService / RedisService
  -> Connector Port
```

MCP 원칙:

- MCP server는 DB password를 직접 보관하지 않는다.
- MCP 요청은 workspace permission을 통과한다.
- MCP 기본 모드는 read-only다.
- destructive query는 기본 차단한다.
- 팀 workspace에서는 audit log를 남긴다.

## Audit Log

MVP에서는 local query history로 시작한다. Team 기능이 추가되면 audit log를 별도 모델로 분리한다.

기록 후보:

- user id
- workspace id
- connection id
- query fingerprint
- query type
- execution time
- result status
- error category

기록 금지:

- password
- token
- private key
- secret이 포함된 raw query parameter

## 보안 리뷰가 필요한 변경

아래 변경은 반드시 별도 보안 리뷰가 필요하다.

- secret 저장 방식 변경
- renderer API 추가
- local engine API 인증 방식 변경
- MCP 기능 추가
- cloud sync 추가
- destructive query policy 변경
- team permission 변경
