# Architecture

## 요약

이 프로젝트는 desktop shell, renderer UI, local engine, external adapter를 명확히 분리한다.

```text
Electron Desktop Shell
  -> React Renderer
  -> Go Local Engine
  -> Database / SQLite / OS Keychain
```

핵심 제품 로직은 Go local engine에 둔다. React는 UI 상태와 사용자 상호작용을 담당하고, Electron은 desktop integration과 process lifecycle을 담당한다.

## 전체 구조

```text
apps/
  desktop/
    src/
      main/
      preload/

  renderer/
    src/
      features/
      shared/
      app/

engine/
  cmd/
    app-engine/

  internal/
    domain/
    application/
    ports/
    adapters/
    transport/
    composition/
```

## Dependency Rule

의존성은 항상 안쪽으로 향한다.

```text
Frameworks and Drivers
  -> Interface / Transport / Adapters
  -> Application
  -> Domain
```

금지되는 방향:

- `domain`이 DB driver를 import한다.
- `domain`이 logger, HTTP, SQLite, Redis SDK를 import한다.
- `application`이 MySQL/PostgreSQL/Redis SDK를 직접 호출한다.
- React renderer가 DB에 직접 접속한다.
- Electron main process가 query business rule을 직접 구현한다.

## Electron Desktop Shell

Electron은 desktop shell 역할만 담당한다.

책임:

- application window 생성
- menu, tray, shortcut 관리
- app update 준비
- Go local engine process lifecycle 관리
- OS별 path 관리
- renderer와 local engine 사이의 secure bridge 제공

비책임:

- SQL 실행 정책
- DB driver 호출
- schema introspection
- saved query business rule
- permission rule

## React Renderer

React renderer는 사용자 인터페이스만 담당한다.

책임:

- connection manager UI
- schema explorer UI
- SQL editor UI
- result grid UI
- Redis explorer UI
- settings UI
- optimistic UI state

비책임:

- DB credential 보관
- DB driver 호출
- query policy 판단
- destructive query 최종 허용 판단

## Go Local Engine

Go local engine은 제품의 핵심 application logic을 담당한다.

책임:

- connection profile 관리
- DB connection lifecycle
- schema introspection
- SQL query execution
- Redis key exploration
- saved query 관리
- query history 관리
- local workspace 관리
- permission/policy enforcement
- SQLite metadata 저장
- OS keychain secret 저장

## Engine Layer Structure

```text
engine/internal/domain/
  connection.go
  workspace.go
  query.go
  schema.go
  result.go
  redis.go
  saved_query.go
  policy.go

engine/internal/application/
  connection_service.go
  schema_service.go
  query_service.go
  redis_service.go
  workspace_service.go
  saved_query_service.go
  policy_service.go

engine/internal/ports/
  sql_connector.go
  redis_connector.go
  profile_repository.go
  workspace_repository.go
  saved_query_repository.go
  query_history_repository.go
  migration_repository.go
  secret_store.go
  clock.go

engine/internal/adapters/
  mysql/
  postgres/
  redis/
  sqlite/
  keychain/

engine/internal/transport/
  http/
  streaming/

engine/internal/composition/
  container.go
```

## Domain Layer

Domain layer는 순수한 비즈니스 규칙과 모델만 가진다.

예시 책임:

- connection profile validation
- workspace ownership rule
- saved query visibility rule
- query policy rule
- destructive query classification
- Redis key operation rule

Domain layer는 외부 IO를 수행하지 않는다.

## Application Layer

Application layer는 use case orchestration을 담당한다.

예시:

- `CreateConnectionProfile`
- `TestConnection`
- `ListSchemas`
- `ExecuteQuery`
- `CancelQuery`
- `ScanRedisKeys`
- `SaveQuery`
- `RecordQueryHistory`

Application layer는 port interface에만 의존한다.

## Ports

Ports는 application이 외부 세계와 통신하기 위한 interface다.

예시:

```go
type SQLConnector interface {
    TestConnection(ctx context.Context, profile ConnectionProfile) error
    ListDatabases(ctx context.Context, conn ConnectionID) ([]DatabaseInfo, error)
    ListSchemas(ctx context.Context, conn ConnectionID, database string) ([]SchemaInfo, error)
    ListTables(ctx context.Context, conn ConnectionID, ref SchemaRef) ([]TableInfo, error)
    DescribeTable(ctx context.Context, conn ConnectionID, ref TableRef) (TableDescription, error)
    Execute(ctx context.Context, req QueryRequest) (QueryResultStream, error)
    Cancel(ctx context.Context, queryID QueryID) error
}
```

`Cancel`은 공통 이름을 가지지만 adapter별 구현이 다르다. PostgreSQL은 driver의 cancel request 계열 기능을 사용하고, MySQL은 query가 실행 중인 connection을 추적한 뒤 별도 connection에서 kill command를 실행해야 한다. 따라서 engine은 `queryID -> driver session` 매핑을 application 또는 adapter boundary에서 추적한다.

```go
type RedisConnector interface {
    TestConnection(ctx context.Context, profile ConnectionProfile) error
    ScanKeys(ctx context.Context, req RedisScanRequest) (RedisScanResult, error)
    GetKey(ctx context.Context, req RedisGetRequest) (RedisValue, error)
    SetKey(ctx context.Context, req RedisSetRequest) error
    DeleteKey(ctx context.Context, req RedisDeleteRequest) error
}
```

## Adapters

Adapters는 ports의 실제 구현이다.

예시:

- MySQL adapter
- PostgreSQL adapter
- Redis adapter
- SQLite repository
- OS keychain secret store
- future cloud sync adapter
- future MCP adapter

Adapter는 외부 SDK와 driver를 import할 수 있다. 이 import는 adapter 바깥으로 새지 않아야 한다.

## Transport

초기 transport는 local HTTP API로 시작한다.

권장 방식:

```text
Electron main starts Go engine
Go engine listens on 127.0.0.1:{random_port}
Go engine requires per-launch auth token
Renderer calls typed preload API
Electron main proxies calls to Go engine
```

Renderer가 local engine token을 직접 다루지 않도록 한다.

### Engine Handshake

Phase 0에서 local engine port handoff를 명시적으로 구현한다.

규칙:

- Electron main process가 launch token과 handshake file path를 engine process argument로 전달한다.
- Go engine은 random port bind 후 handshake file에 `port`, `pid`, `ready`, `startedAt`을 atomic write로 기록한다.
- Electron main process는 handshake file을 읽고 `/health`를 token과 함께 확인한다.
- stdout parsing은 진단 log로만 사용하고 readiness contract로 사용하지 않는다.
- renderer와 preload는 port나 token을 보관하지 않는다.

### Sandbox and Preload Responsibility

Electron renderer는 `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`를 목표로 한다.

이 전제에서 preload는 Node/HTTP client 역할을 하지 않는다. Preload는 typed IPC wrapper만 제공하고, HTTP 요청과 token 보관은 Electron main process가 담당한다.

### Result Streaming

SQL result 전송은 ADR 0004에 따라 NDJSON streaming으로 시작한다.

규칙:

- 기본 query는 row limit을 적용한다.
- 대용량 조회는 사용자가 명시적으로 large result fetch를 선택해야 한다.
- engine은 전체 result set을 메모리에 버퍼링하지 않는다.
- renderer grid가 처리하지 못하는 경우 Electron main process와 renderer 사이에서 chunk 단위 backpressure를 적용한다.
- cancellation은 stream close와 driver-specific cancel을 모두 수행한다.

## Storage

SQLite에는 metadata만 저장한다.

저장 가능:

- workspace
- connection profile metadata
- `secretRef`
- saved query
- query history
- settings
- sync metadata

저장 금지:

- DB password
- DB access token
- private key
- client certificate private key

Secret은 OS keychain에 저장한다.

SQLite schema 변경은 ADR 0005의 migration 정책을 따른다. 앱 시작 시 migration을 적용하기 전 schema version을 확인하고, migration 실패 시 기존 user data를 덮어쓰지 않는다.

## Future Cloud Architecture

Cloud 기능은 local engine 위에 sync adapter로 추가한다.

```text
Cloud Sync Adapter
  -> WorkspaceService
  -> SavedQueryService
  -> PolicyService
  -> SQLite Repository
```

Cloud 기능이 DB connector를 직접 호출하면 안 된다.

## Future MCP Architecture

MCP 기능은 application service 위에 얹는다.

```text
MCP Adapter
  -> PolicyService
  -> QueryService
  -> SQLConnector / RedisConnector
```

MCP는 DB credential을 직접 소유하지 않는다. MCP 요청은 앱의 permission, read-only, destructive query policy를 반드시 통과해야 한다.
