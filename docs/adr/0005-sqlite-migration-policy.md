# ADR 0005: SQLite Migration Policy

## Status

Accepted

## Context

이 앱은 local-first desktop app이며, saved query, query history, workspace, connection metadata를 SQLite에 저장한다.

앱 업데이트 중 SQLite schema migration이 실패하면 사용자의 로컬 데이터가 손상될 수 있다. 따라서 migration 정책은 초기부터 명시해야 한다.

## Decision

SQLite는 versioned migration runner로 관리한다.

기본 정책:

- `schema_migrations` table에 적용된 migration version과 checksum을 기록한다.
- migration은 순차적으로만 적용한다.
- migration file은 한 번 배포된 뒤 수정하지 않는다.
- 앱 시작 시 migration 적용 전 database backup 또는 safe checkpoint를 만든다.
- migration 실패 시 앱은 기존 DB를 덮어쓰지 않고 recovery UI를 표시한다.
- destructive migration은 금지하고, 필요한 경우 copy-and-swap 방식으로 수행한다.

## Rollback Policy

SQLite migration은 자동 down migration에 의존하지 않는다.

실패 시 정책:

- 실패한 migration transaction을 rollback한다.
- migration 전 backup 또는 checkpoint를 유지한다.
- 사용자가 앱을 계속 실행할 수 없으면 recovery path를 표시한다.
- diagnostic export에는 secret을 포함하지 않는다.

## Testing

필수 테스트:

- fresh install migration
- existing user DB migration
- migration idempotency
- checksum mismatch detection
- failed migration rollback
- old app version이 만든 DB fixture upgrade

## Consequences

장점:

- 앱 업데이트로 사용자 local data를 손상시킬 위험을 줄인다.
- migration 실패가 조용히 지나가지 않는다.
- future cloud sync metadata를 안전하게 추가할 수 있다.

단점:

- 초기 persistence layer 구현량이 늘어난다.
- migration fixture 관리가 필요하다.
- packaging smoke test와 integration test에 SQLite migration 검증이 포함된다.

## Follow-up

- Phase 1에서 migration runner와 `schema_migrations` table을 먼저 구현한다.
- 테스트 fixture로 v1 SQLite DB를 유지한다.
- release checklist에 migration smoke test를 추가한다.
