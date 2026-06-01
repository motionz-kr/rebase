# Database Desktop Tool Documentation

이 디렉터리는 데이터베이스 데스크톱 툴 프로젝트의 제품 목적, 범위, 아키텍처, 개발 원칙, 테스트 전략, 보안 원칙, 주요 의사결정을 기록한다.

새로 합류한 개발자나 이어서 작업하는 사람은 아래 순서로 읽는다.

## 읽는 순서

1. [product-brief.md](./product-brief.md)
   - 이 프로젝트가 무엇을 만들고, 무엇을 만들지 않는지 설명한다.
2. [roadmap.md](./roadmap.md)
   - MVP부터 팀 기능, MCP 확장까지의 단계별 범위를 설명한다.
3. [architecture.md](./architecture.md)
   - Electron, React, Go local engine, database adapter, storage의 경계를 설명한다.
4. [development-schedule.md](./development-schedule.md)
   - 12주 MVP 일정과 3주 architecture risk burn-down 계획을 설명한다.
5. [development-principles.md](./development-principles.md)
   - Clean Architecture, Ports and Adapters, TDD, vertical slice 개발 원칙을 설명한다.
6. [testing-strategy.md](./testing-strategy.md)
   - unit, use case, contract, integration, desktop E2E 테스트 전략을 설명한다.
7. [security.md](./security.md)
   - DB credential, local API, destructive query, MCP 연동 보안 원칙을 설명한다.
8. [adr/](./adr)
   - 중요한 기술 선택과 그 이유를 ADR 형태로 기록한다.

## 현재 ADR

- [0001: Desktop Architecture](./adr/0001-desktop-architecture.md)
- [0002: Local Engine Clean Architecture](./adr/0002-local-engine-clean-architecture.md)
- [0003: Storage and Secret Management](./adr/0003-storage-and-secret-management.md)
- [0004: Result Streaming and Cancellation](./adr/0004-result-streaming-and-cancellation.md)
- [0005: SQLite Migration Policy](./adr/0005-sqlite-migration-policy.md)

## 현재 핵심 결정

- macOS와 Windows를 모두 지원하는 desktop app으로 만든다.
- UI는 React + TypeScript로 만든다.
- Desktop shell은 Electron이 담당한다.
- 핵심 DB 로직은 Go local engine이 담당한다.
- 초기 DB 지원 범위는 MySQL, PostgreSQL, Redis다.
- RDS와 managed database 접속을 MVP 타깃으로 보므로 TLS 설정은 초기 connection 범위에 포함한다.
- Phase 0에서 macOS/Windows thin packaging smoke test를 먼저 수행해 Go binary path, keychain, SQLite path 리스크를 조기에 검증한다.
- SQLite에는 metadata만 저장한다.
- DB password, token, private key 같은 secret은 OS keychain에 저장한다.
- 장기적으로 account, team workspace, shared SQL, MCP connection settings를 추가할 수 있는 구조로 만든다.

## 문서 유지 규칙

- 아키텍처 경계를 바꾸는 변경은 `architecture.md`와 ADR을 함께 갱신한다.
- 보안에 영향을 주는 변경은 `security.md`를 함께 갱신한다.
- 테스트 전략을 바꾸는 변경은 `testing-strategy.md`를 함께 갱신한다.
- 구현 편의를 위해 임시 우회를 추가했다면, 문서에 남기고 제거 기준을 명확히 적는다.
