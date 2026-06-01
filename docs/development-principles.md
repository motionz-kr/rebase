# Development Principles

## 핵심 원칙

이 프로젝트는 빠른 prototype보다 장기 유지보수성과 확장성을 우선한다.

핵심 원칙:

- 작은 변경을 선호한다.
- 관련 없는 리팩터링을 섞지 않는다.
- Clean Architecture dependency rule을 지킨다.
- Ports and Adapters로 외부 기술을 격리한다.
- TDD Red -> Green -> Refactor 흐름을 따른다.
- 기능은 vertical slice로 구현한다.
- DB driver 차이는 adapter에 가둔다.
- UI는 application policy를 재구현하지 않는다.

## TDD Workflow

모든 핵심 기능은 아래 순서로 구현한다.

1. 실패하는 테스트를 먼저 작성한다.
2. 실패 이유가 기대한 이유인지 확인한다.
3. 테스트를 통과시키는 최소 구현을 작성한다.
4. 테스트가 통과하는지 확인한다.
5. 중복과 경계를 정리한다.
6. 필요한 경우 contract/integration test를 추가한다.

예시:

```text
RED:
read-only workspace에서 DELETE query를 실행하면 차단되어야 한다.

GREEN:
PolicyService가 destructive query를 감지하고 QueryService가 실행을 거부한다.

REFACTOR:
SQL classification rule을 domain service로 이동한다.
```

## Vertical Slice 개발

DB 하나를 완전히 만든 뒤 다음 DB로 넘어가지 않는다.

권장 순서:

1. Electron, React, Go engine handshake와 thin packaged smoke를 먼저 구현한다.
2. SQLite/keychain/profile foundation slice를 구현한다.
3. connection test slice를 TLS 포함 MySQL, PostgreSQL, Redis에 얇게 구현한다.
4. SQL schema explorer slice를 MySQL, PostgreSQL에 구현한다.
5. SQL query execution, streaming, cancellation slice를 MySQL, PostgreSQL에 구현한다.
6. Redis key explorer slice를 구현한다.
7. saved query와 persistent query history를 workspace에 연결한다.

이 방식은 architecture boundary가 실제로 올바른지 빨리 검증한다.

## Layer별 규칙

### Domain

허용:

- entity
- value object
- domain service
- domain error
- 순수 validation

금지:

- DB driver import
- HTTP import
- Electron import
- logger import
- SQLite import
- OS keychain import

### Application

허용:

- use case orchestration
- transaction boundary
- port 호출
- policy orchestration

금지:

- MySQL/PostgreSQL/Redis SDK 직접 호출
- SQLite 직접 호출
- UI 상태 관리
- Electron IPC 처리

### Adapters

허용:

- DB driver 호출
- SQLite 접근
- OS keychain 접근
- external API 호출
- low-level error mapping

규칙:

- adapter error는 application이 이해할 수 있는 error로 normalize한다.
- driver-specific type은 adapter 밖으로 노출하지 않는다.

### Transport

허용:

- local HTTP routing
- request validation
- response mapping
- stream protocol

금지:

- business rule 구현
- DB driver 직접 호출
- repository 직접 호출

### React Renderer

허용:

- UI composition
- form validation
- local UI state
- API client 호출

금지:

- DB credential 직접 처리
- DB connection string 생성
- query permission 최종 판단
- destructive query 최종 허용

## Commit 단위

권장 commit 단위:

- domain model + unit test
- use case + fake port test
- adapter contract test
- adapter implementation
- UI slice
- documentation update

한 commit에 feature와 대규모 정리를 섞지 않는다.

## 새 DB Adapter 추가 기준

새 DB를 추가할 때는 아래를 만족해야 한다.

- port contract가 먼저 정의되어 있다.
- fake adapter로 application test가 가능하다.
- in-memory fake adapter와 실제 adapter가 동일한 contract test suite를 통과한다.
- driver-specific error가 normalized error로 변환된다.
- UI에 driver-specific 분기가 과도하게 추가되지 않는다.

## 문서화 기준

아래 변경은 문서 갱신을 포함해야 한다.

- layer boundary 변경
- storage 정책 변경
- secret 처리 방식 변경
- query policy 변경
- MCP 접근 정책 변경
- supported DB 추가
- packaging 방식 변경
