# Roadmap

이 로드맵은 기능을 작고 검증 가능한 단계로 나누기 위한 기준이다. 각 단계는 독립적으로 테스트 가능해야 하며, 다음 단계의 전제 조건을 명확히 제공해야 한다.

## Phase 0: Foundation and Packaging Smoke

목표: desktop app, renderer, local engine이 통신할 수 있는 최소 구조를 만들고, packaging 리스크를 가장 먼저 얇게 검증한다.

범위:

- Electron app bootstrapping
- React renderer bootstrapping
- Go local engine bootstrapping
- Electron main process에서 Go engine lifecycle 관리
- local engine explicit handshake
- local API health check
- preload는 typed API만 노출하고 HTTP 호출은 Electron main process가 담당
- macOS development run
- Windows development run
- macOS thin packaged build smoke test
- Windows thin packaged build smoke test
- packaged 상태에서 keychain read/write 1회
- packaged 상태에서 SQLite path 생성 1회

완료 기준:

- 앱을 실행하면 React UI가 표시된다.
- Go engine이 함께 실행된다.
- Electron main process가 engine handshake로 port와 readiness를 확인한다.
- UI에서 Electron main process를 통해 engine health 상태를 확인할 수 있다.
- 앱 종료 시 Go engine process가 정리된다.
- packaged app에서 Go engine binary path가 macOS와 Windows 모두에서 확인된다.
- packaged app에서 keychain read/write와 SQLite file creation이 각각 1회 성공한다.
- macOS hardened runtime, App Sandbox, signing 조합에서의 keychain 리스크는 Phase 7에서 검증한다는 한계를 명시한다.

## Phase 1: Local Persistence and Profile Foundation

목표: connection profile metadata, secret 저장, SQLite migration의 기초를 만든다.

범위:

- connection profile CRUD
- OS keychain secret 저장
- SQLite metadata 저장
- SQLite migration runner
- `secretRef`와 keychain entry 정합성 검사
- local-only connection profile UI

완료 기준:

- password는 SQLite에 저장되지 않는다.
- SQLite migration은 version table을 사용하고 재실행해도 안전하다.
- keychain entry가 누락된 profile은 재입력 상태로 표시된다.
- in-memory fake repository와 SQLite repository가 동일한 repository contract test를 통과한다.

## Phase 2: Driver Connection Slices

목표: MySQL, PostgreSQL, Redis connection test를 실제 driver와 TLS 옵션까지 포함해 검증한다.

범위:

- SQL connector port
- MySQL adapter
- PostgreSQL adapter
- Redis connector port
- Redis adapter
- TLS option model
- MySQL TLS connection test
- PostgreSQL TLS connection test
- Redis TLS connection test
- connection error normalization

완료 기준:

- 3개 DB 유형의 plain connection test가 가능하다.
- 3개 DB 유형의 TLS connection test가 가능하다.
- 인증 실패, host 접근 실패, TLS 설정 실패, timeout을 구분해 표시한다.
- MySQL, PostgreSQL, Redis adapter와 in-memory fake adapter가 동일한 contract test suite를 통과한다.

## Phase 3: SQL Explorer

목표: MySQL/PostgreSQL의 database, schema, table, column 정보를 탐색한다.

범위:

- database/schema/table/column introspection port
- MySQL introspection adapter
- PostgreSQL introspection adapter
- database/schema/table/column introspection
- schema explorer UI
- adapter contract test

완료 기준:

- MySQL과 PostgreSQL에서 동일한 UI로 schema tree를 볼 수 있다.
- 각 adapter가 동일한 contract test를 통과한다.
- 1,000개 table fixture에서 schema tree 첫 화면이 1초 이내에 렌더링된다.

## Phase 4: SQL Query Execution

목표: SQL editor에서 query를 실행하고 결과를 grid로 확인한다.

범위:

- Monaco Editor
- query tab
- query execution use case
- NDJSON result streaming
- default row limit
- opt-in large result fetch
- timeout
- cancellation registry
- PostgreSQL cancellation implementation
- MySQL cancellation implementation
- session-scoped query history
- result grid virtualization

완료 기준:

- MySQL/PostgreSQL query 실행이 가능하다.
- 기본 row limit이 적용되고, 사용자가 명시적으로 large result fetch를 선택해야 제한을 늘릴 수 있다.
- 50,000 row fixture를 streaming으로 받아도 engine이 전체 result를 메모리에 버퍼링하지 않는다.
- 50,000 row grid에서 스크롤 중 main thread long task가 200ms를 넘지 않는다.
- PostgreSQL long-running query cancel이 driver-specific contract test를 통과한다.
- MySQL long-running query cancel이 driver-specific contract test를 통과한다.
- session-scoped query history가 앱 실행 중 재실행 가능한 형태로 유지된다.

## Phase 5: Redis Explorer

목표: Redis keyspace를 탐색하고 주요 자료형의 value를 조회한다.

범위:

- SCAN 기반 key 탐색
- key pattern search
- string/hash/list/set/zset 조회
- TTL 표시
- read-only default mode

완료 기준:

- `KEYS *`를 사용하지 않고 `SCAN`만 사용한다.
- 1,000,000 key fixture에서 scan request p95가 200ms 이내로 유지된다.
- 주요 자료형을 안전하게 조회한다.
- write/delete 기능은 명시적 confirmation 없이는 실행되지 않는다.

## Phase 6: Local Workspace

목표: saved SQL, query history, favorite query를 local workspace 단위로 영속 관리한다.

범위:

- workspace model
- saved query model
- persistent query history model
- local SQLite repository
- workspace-aware UI

완료 기준:

- 앱 재시작 후 saved SQL과 history가 유지된다.
- saved query는 workspace와 connection에 연결된다.
- Phase 4의 session-scoped history가 workspace-scoped persistent history로 승격된다.
- future cloud sync를 위한 `remoteId`, `version`, `syncState` 확장 지점을 가진다.

## Phase 7: Packaging Hardening

목표: Phase 0의 thin packaging smoke를 실제 배포 가능한 수준으로 강화한다.

범위:

- macOS build
- Windows build
- code signing 준비
- auto-update 전략 결정
- packaging smoke test

완료 기준:

- macOS와 Windows에서 설치 및 실행 가능하다.
- packaged app에서 Go engine이 정상 실행된다.
- packaged app에서 keychain과 SQLite 저장소가 정상 동작한다.
- signed/sandbox 후보 설정에서 keychain read/write smoke test가 통과한다.
- Phase 0에서 의도적으로 이연한 macOS hardened runtime, App Sandbox, signing 조합의 keychain 동작을 검증한다.

## Phase 8: Account, Team, MCP 준비

목표: local-first 구조 위에 cloud/team/MCP 기능을 추가할 수 있는 경계를 확정한다.

범위:

- account model
- team workspace model
- cloud sync adapter boundary
- shared SQL permission model
- MCP settings model
- MCP policy model

완료 기준:

- local workspace가 cloud workspace와 충돌하지 않는 모델을 가진다.
- MCP가 DB credential에 직접 접근하지 않고 application service를 통해서만 query를 실행한다.
