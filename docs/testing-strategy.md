# Testing Strategy

## 목표

테스트 전략의 목표는 DB adapter가 늘어나도 핵심 use case와 policy가 안정적으로 유지되도록 하는 것이다.

테스트는 아래 계층으로 나눈다.

```text
Domain Unit Tests
  -> Application Use Case Tests
  -> Adapter Contract Tests
  -> Integration Tests
  -> Desktop E2E Tests
```

## Domain Unit Tests

대상:

- connection profile validation
- workspace rule
- saved query visibility
- query policy
- destructive query classification
- Redis key operation policy

특징:

- DB를 사용하지 않는다.
- 파일 시스템을 사용하지 않는다.
- 네트워크를 사용하지 않는다.
- 빠르게 실행되어야 한다.

예시 테스트:

- read-only workspace에서는 write query가 금지된다.
- private saved query는 같은 user에게만 보인다.
- connection profile은 driver별 필수 필드를 검증한다.

## Application Use Case Tests

대상:

- create connection profile
- test connection
- list schemas
- execute query
- cancel query
- scan Redis keys
- save query
- record query history

특징:

- fake port를 사용한다.
- 실제 DB driver를 사용하지 않는다.
- use case orchestration과 policy 적용을 검증한다.
- fake port는 실제 adapter와 같은 contract test suite를 통과해야 한다.

예시:

```text
Given:
  workspace가 read-only이고 query가 DELETE다.

When:
  ExecuteQuery use case를 실행한다.

Then:
  SQLConnector.Execute는 호출되지 않는다.
  use case는 policy error를 반환한다.
```

## Adapter Contract Tests

대상:

- MySQL adapter
- PostgreSQL adapter
- Redis adapter
- SQLite repository
- OS keychain secret store

목표:

- 같은 port를 구현하는 adapter들이 동일한 동작 계약을 만족하는지 검증한다.
- in-memory fake adapter도 동일한 contract test suite를 통과해야 한다. 그렇지 않으면 use case test가 실제 adapter behavior와 드리프트할 수 있다.

SQL adapter contract 예시:

- invalid credential은 authentication error로 normalize한다.
- unreachable host는 network error로 normalize한다.
- query timeout은 timeout error로 normalize한다.
- `ListTables`는 stable table metadata를 반환한다.
- `Execute`는 column metadata와 row stream을 반환한다.
- `Cancel`은 long-running query를 중단하고 normalized cancellation result를 반환한다.
- TLS 설정 실패는 authentication/network error와 구분된다.

Redis adapter contract 예시:

- `ScanKeys`는 cursor 기반 pagination을 지원한다.
- 없는 key 조회는 not found result를 반환한다.
- string/hash/list/set/zset type을 구분한다.
- TTL이 없는 key와 만료 예정 key를 구분한다.

## Integration Tests

대상:

- 실제 MySQL
- 실제 PostgreSQL
- 실제 Redis
- SQLite migration

권장 방식:

- testcontainers를 사용해 테스트 DB를 실행한다.
- schema fixture를 명시적으로 적용한다.
- adapter와 실제 driver behavior를 검증한다.

검증 항목:

- connection 성공
- authentication 실패
- schema introspection
- query execution
- timeout
- cancellation
- TLS connection
- Redis scan
- Redis value read
- SQLite migration rollback

## Desktop E2E Tests

대상:

- Electron shell
- React renderer
- Go local engine process
- local API bridge

검증 항목:

- 앱 실행
- engine health check
- engine handshake
- connection profile 생성
- connection test
- query 실행
- result grid 표시
- Redis key 조회
- 앱 종료 시 engine process 정리

Desktop E2E는 느리므로 핵심 사용자 흐름만 검증한다.

## Packaging Smoke Tests

Phase 0부터 macOS와 Windows thin packaging smoke test를 수행한다. Phase 7에서는 signed/sandbox 후보 설정으로 같은 smoke test를 강화한다.

- 앱 설치 및 실행
- Go engine 포함 여부
- engine handshake
- keychain access
- SQLite path 생성
- connection test
- 앱 종료 시 process 정리

## Performance Tests

완료 기준이 정성 문구에 머무르지 않도록 아래 수치를 기본 기준으로 둔다.

- 1,000개 table fixture에서 schema tree 첫 화면이 1초 이내에 렌더링된다.
- 50,000 row SQL result fixture를 streaming으로 받을 때 engine이 전체 result를 메모리에 버퍼링하지 않는다.
- 50,000 row grid 스크롤 중 renderer main thread long task가 200ms를 넘지 않는다.
- 1,000,000 key Redis fixture에서 scan request p95가 200ms 이내다.

## 테스트 우선순위

기능 구현 시 우선순위:

1. Domain unit test
2. Application use case test
3. Adapter contract test
4. Integration test
5. UI/E2E test

UI만 변경하는 경우에도 핵심 user flow에 영향이 있으면 E2E 또는 component test를 추가한다.

## 테스트에서 피해야 할 것

- 실제 개인 DB나 운영 DB에 연결하는 테스트
- 테스트 순서에 의존하는 테스트
- sleep 기반 timing test
- UI snapshot만으로 동작을 검증하는 테스트
- driver-specific behavior를 application test에 노출하는 테스트
