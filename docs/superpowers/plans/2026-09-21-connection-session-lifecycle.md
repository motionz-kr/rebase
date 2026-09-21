# Connection session lifecycle 개선 계획

## 목표

DataGrip처럼 연결을 끊을 때 현재 실행과 트랜잭션을 명확히 정리한다.

- Disconnect 시 실행 중인 query stream과 engine query를 취소한다.
- 미커밋 manual transaction이 있으면 사용자에게 Commit/Rollback을 선택하게 한다.
- 세션 close가 끝난 뒤에만 연결을 UI에서 제거한다.
- 연결 끊기/재연결 핵심 흐름을 desktop E2E로 고정한다.

## 범위

- renderer connection lifecycle coordinator와 QueryEditor cleanup 경계
- Electron IPC에 연결별 실행 취소/세션 close orchestration 연결
- 기존 query cancellation/session API 재사용
- SQLite 임시 DB 기반 E2E

## 구현 순서

1. 연결 lifecycle 순수 로직에 대한 실패 테스트를 작성한다.
2. 실행 중 query와 manual transaction 상태를 추적할 수 있도록 QueryEditor 계약을 정리한다.
3. Disconnect 전에 transaction 확인을 수행하고, 승인된 경우 query cancel 및 session close를 기다린다.
4. 연결 실패 후 재연결과 disconnect 후 재접속 흐름을 검증한다.
5. renderer/engine 테스트와 실제 Electron Playwright E2E를 실행한다.
6. 보안·쿼리 정책 문서가 영향을 받는지 확인하고 필요한 경우 갱신한다.

## 완료 기준

- 실행 중 SELECT를 Disconnect하면 DB query가 취소되고 해당 연결이 제거된다.
- 미커밋 transaction에서 Disconnect하면 Commit/Rollback 선택 전에는 연결이 유지된다.
- Rollback 후 Disconnect하면 세션이 닫히고 연결을 다시 클릭해 재접속할 수 있다.
- 기존 연결 전환, query cancel, transaction commit/rollback 동작이 유지된다.
