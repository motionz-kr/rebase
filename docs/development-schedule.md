# Development Schedule

이 문서는 개발자에게 작업을 위임하기 위한 1차 MVP 일정이다. 세부 기능 범위는 [roadmap.md](./roadmap.md)를 기준으로 하며, 이 문서는 언제 어떤 리스크를 먼저 제거할지에 초점을 둔다.

기준 시작일은 2026-06-01이다. 실제 시작일이 달라지면 주차만 유지하고 날짜를 이동한다.

## 일정 원칙

- 1차 MVP는 12주로 계획한다.
- 처음 3주는 기능 확장보다 architecture risk burn-down에 집중한다.
- macOS와 Windows를 매주 함께 확인한다.
- 패키징, keychain, Go engine process, TLS connection, cancellation은 늦게 발견하면 비용이 크므로 앞쪽에서 검증한다.
- 각 주차는 재현 가능한 smoke script, test, 또는 체크리스트를 남긴다.

## 12주 MVP 일정

| 주차 | 기간 | 목표 | 주요 산출물 |
| --- | --- | --- | --- |
| 1주차 | 2026-06-01 ~ 2026-06-05 | Phase 0 foundation | Electron + React + Go engine 부팅, explicit handshake, macOS/Windows thin package smoke |
| 2주차 | 2026-06-08 ~ 2026-06-12 | Phase 1 persistence foundation | SQLite migration runner, OS keychain 저장, connection profile foundation |
| 3주차 | 2026-06-15 ~ 2026-06-19 | Phase 2 driver connection | MySQL/PostgreSQL/Redis connection test, TLS 옵션, error normalization |
| 4주차 | 2026-06-22 ~ 2026-06-26 | Phase 3 SQL explorer | MySQL/PostgreSQL schema explorer, introspection contract test |
| 5주차 | 2026-06-29 ~ 2026-07-03 | Phase 4 query base | SQL editor, query execution use case, default row limit |
| 6주차 | 2026-07-06 ~ 2026-07-10 | Phase 4 result grid | result grid virtualization, session-scoped query history |
| 7주차 | 2026-07-13 ~ 2026-07-17 | Phase 4 streaming/cancellation | NDJSON streaming, cancellation registry, PostgreSQL/MySQL cancellation |
| 8주차 | 2026-07-20 ~ 2026-07-24 | Phase 5 Redis explorer | SCAN 기반 key explorer, value/type/TTL 조회 |
| 9주차 | 2026-07-27 ~ 2026-07-31 | Phase 6 local workspace | workspace, saved SQL, persistent query history |
| 10주차 | 2026-08-03 ~ 2026-08-07 | Phase 7 packaging hardening | macOS/Windows packaging, signed/sandbox 후보, keychain smoke |
| 11주차 | 2026-08-10 ~ 2026-08-14 | QA and performance | E2E, testcontainers integration, performance 기준 검증 |
| 12주차 | 2026-08-17 ~ 2026-08-21 | Beta readiness | 내부 배포, known issues, 문서 정리, 다음 phase 계획 |

## 3주 Architecture Risk Burn-down

처음 3주는 별도 gate로 운영한다. 이 구간이 통과되지 않으면 SQL editor나 Redis explorer 같은 상위 기능으로 넘어가지 않는다.

### Week 1: Desktop and Engine Foundation

목표:

- Electron, React, Go engine이 하나의 desktop app으로 부팅된다.
- Electron main process가 Go engine process lifecycle을 관리한다.
- renderer는 engine port와 token을 직접 알지 못한다.
- macOS/Windows thin packaged app에서 최소 smoke가 통과한다.

작업:

- repo scaffold
- Electron main/preload 구조 생성
- React renderer 생성
- Go engine entrypoint 생성
- Electron main에서 Go engine process start/stop 구현
- handshake file 기반 `port`, `pid`, `ready`, `startedAt` 전달 구현
- Electron main에서 `/health` 호출
- renderer에서 preload IPC를 통해 health 표시
- macOS thin package 생성
- Windows thin package 생성
- packaged app에서 Go binary path 확인
- packaged app에서 keychain write/read 1회
- packaged app에서 SQLite file 생성 1회

완료 기준:

- macOS development run 성공
- Windows development run 성공
- macOS thin package smoke 성공
- Windows thin package smoke 성공
- 앱 종료 시 Go engine orphan process가 남지 않는다.
- renderer code에서 engine token과 port를 직접 참조하지 않는다.
- smoke script 또는 체크리스트로 재현 가능하다.
- macOS hardened runtime, App Sandbox, signing 조합의 keychain 검증은 Phase 7로 이연했다는 한계를 기록한다.

### Week 2: Local Persistence Foundation

목표:

- local-first metadata 저장과 secret 저장 경계를 확정한다.
- SQLite migration 실패가 사용자 데이터를 덮어쓰지 않는 구조를 만든다.

작업:

- SQLite schema bootstrap
- `schema_migrations` table 생성
- migration runner 구현
- migration checksum 검증
- failed migration rollback 테스트
- connection profile metadata repository 구현
- in-memory fake repository 구현
- fake repository와 SQLite repository에 동일한 contract test 적용
- OS keychain secret store 구현
- `secretRef` 저장
- keychain entry 누락 시 재입력 상태 표시

완료 기준:

- password/token/private key가 SQLite에 저장되지 않는다.
- migration은 idempotent하게 실행된다.
- failed migration rollback test가 통과한다.
- fake repository와 SQLite repository가 동일한 contract test suite를 통과한다.
- macOS/Windows에서 keychain read/write smoke가 통과한다.

### Week 3: Driver Connection Foundation

목표:

- MySQL, PostgreSQL, Redis connection test가 plain/TLS 양쪽에서 동작한다.
- driver-specific error가 application에서 이해 가능한 error로 normalize된다.

작업:

- SQL connector port 정의
- Redis connector port 정의
- MySQL adapter connection test 구현
- PostgreSQL adapter connection test 구현
- Redis adapter connection test 구현
- TLS option model 구현
- MySQL TLS test fixture 구성
- PostgreSQL TLS test fixture 구성
- Redis TLS test fixture 구성
- authentication/network/TLS/timeout error normalization 구현
- fake adapter와 실제 adapter에 동일한 contract test 적용

완료 기준:

- MySQL plain connection test 성공
- MySQL TLS connection test 성공
- PostgreSQL plain connection test 성공
- PostgreSQL TLS connection test 성공
- Redis plain connection test 성공
- Redis TLS connection test 성공
- authentication failure, network failure, TLS failure, timeout이 구분된다.
- fake adapter와 실제 adapter가 동일한 connection contract test suite를 통과한다.

## 인력별 권장 배치

### 개발자 1명

12주 일정을 그대로 따른다. 병렬화보다 architecture boundary와 테스트 안정성을 우선한다.

주의:

- 1주차부터 Windows 확인을 미루지 않는다.
- UI polish는 7주차 전까지 최소화한다.
- Redis explorer는 SQL query execution이 안정화된 뒤 시작한다.

### 개발자 2명

8~10주로 압축 가능하지만, 첫 3주는 같은 risk burn-down 목표를 공유한다.

권장 분담:

- 개발자 A: Electron shell, Go engine, persistence, DB adapters, packaging
- 개발자 B: React renderer, connection manager UI, schema explorer UI, editor/grid UI

주의:

- 개발자 B가 mock API로 UI를 만들더라도 fake adapter contract와 API schema를 기준으로 작업한다.
- UI가 DB policy를 재구현하지 않는다.
- packaging smoke는 개발자 A만의 책임이 아니라 매주 공유 gate로 본다.

## Gate 기준

### Gate 1: Week 1 종료

통과 조건:

- macOS/Windows thin packaged app이 실행된다.
- Go engine handshake가 동작한다.
- keychain read/write와 SQLite file 생성 smoke가 통과한다.

통과하지 못하면:

- connection manager나 schema explorer로 넘어가지 않는다.
- Electron/Go process boundary와 packaging 문제를 먼저 해결한다.

### Gate 2: Week 3 종료

통과 조건:

- MySQL/PostgreSQL/Redis plain/TLS connection test가 통과한다.
- error normalization이 contract test로 검증된다.
- fake adapter와 실제 adapter가 같은 contract test를 통과한다.

통과하지 못하면:

- SQL editor 구현을 시작하지 않는다.
- driver boundary와 TLS 모델을 먼저 정리한다.

### Gate 3: Week 7 종료

통과 조건:

- MySQL/PostgreSQL query execution이 가능하다.
- NDJSON streaming이 동작한다.
- PostgreSQL/MySQL cancellation contract test가 통과한다.
- 50,000 row fixture에서 engine이 전체 result를 메모리에 버퍼링하지 않는다.

통과하지 못하면:

- Redis explorer와 workspace 기능을 확장하지 않는다.
- query execution foundation을 먼저 안정화한다.

### Gate 4: Week 10 종료

통과 조건:

- macOS/Windows packaged app에서 핵심 flow가 동작한다.
- signed/sandbox 후보 설정에서 keychain read/write smoke가 통과한다.
- 앱 종료 시 orphan process가 남지 않는다.

통과하지 못하면:

- beta readiness로 넘어가지 않는다.
- packaging/signing/keychain 이슈를 먼저 해결한다.

## MVP 이후 일정 후보

MVP 이후에는 아래 순서로 확장한다.

1. SSH tunnel
2. advanced certificate profile
3. export CSV/JSON
4. table data editing
5. explain plan
6. account login
7. team workspace
8. shared SQL permission
9. audit log
10. MCP connection settings
