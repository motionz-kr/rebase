# ADR 0002: Local Engine Clean Architecture

## Status

Accepted

## Context

이 프로젝트의 핵심 복잡도는 DB별 driver 차이, query execution, schema introspection, Redis 자료형 처리, local storage, secret management, future team/MCP policy에 있다.

이 로직이 UI나 transport에 섞이면 DB adapter가 늘어날수록 변경 영향이 커진다.

## Decision

Go local engine은 Clean Architecture와 Ports and Adapters 구조를 따른다.

```text
transport / adapters
  -> application
  -> domain
```

기본 디렉터리:

```text
engine/internal/domain/
engine/internal/application/
engine/internal/ports/
engine/internal/adapters/
engine/internal/transport/
engine/internal/composition/
```

## Rationale

이 구조는 핵심 use case를 DB나 Electron 없이 테스트할 수 있게 한다.

예시:

- `ExecuteQuery` use case는 fake `SQLConnector`로 테스트한다.
- `SaveQuery` use case는 fake repository로 테스트한다.
- `PolicyService`는 DB 없이 destructive query 차단을 테스트한다.
- MySQL/PostgreSQL/Redis 차이는 adapter contract test로 검증한다.

## Rules

- Domain은 외부 기술을 import하지 않는다.
- Application은 port interface에만 의존한다.
- Adapter는 driver-specific type을 바깥으로 노출하지 않는다.
- Transport는 business rule을 구현하지 않는다.
- Composition root에서만 concrete adapter를 연결한다.

## Consequences

장점:

- TDD Red -> Green -> Refactor 흐름에 적합하다.
- DB별 adapter 추가가 application layer를 크게 흔들지 않는다.
- MCP와 team permission을 application service 위에 올릴 수 있다.
- 테스트 속도가 빠른 unit/use case test 중심으로 유지된다.

단점:

- 초기 파일 수가 늘어난다.
- 단순 기능도 port와 use case를 거쳐야 한다.
- composition wiring이 필요하다.

## Follow-up

- architecture boundary를 검사하는 테스트나 lint rule을 추가한다.
- adapter contract test helper를 초기에 만든다.
- domain/application test가 DB 없이 실행되는지 CI에서 검증한다.
