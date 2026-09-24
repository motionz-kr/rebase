# MCP 연결별 완전 쓰기 허용

## 목표

연결별 MCP 쓰기 정책에 `full_access` 모드를 추가해 외부 MCP 클라이언트가
사용자 승인 없이 INSERT/UPDATE/DELETE 및 DDL을 실행할 수 있게 한다. 기존
접근 범위(database/schema/table)와 연결의 읽기 전용 정책은 계속 엔진에서
강제한다.

## 구현 순서

1. 도메인 쓰기 모드 정규화에 `full_access`를 추가하고 저장/서비스 테스트를
   먼저 확장한다.
2. MCP 레지스트리에 `execute_write` 도구를 추가한다. 완전 허용 연결에만
   노출하고, 쓰기 문장인지 확인한 뒤 실제 connector를 read-only=false로
   호출하며 SQL과 결과를 활동 기록에 남긴다.
3. Agent 시스템 지침, 연결 설정 UI, MCP 운영/보안 문서를 갱신한다.
4. 엔진 단위 테스트와 renderer 테스트를 실행하고, SQLite 임시 DB를 사용하는
   Playwright E2E로 설정 저장과 실제 MCP 쓰기 실행을 검증한다.
5. 전체 검증 후 feature 브랜치를 커밋해 PR을 만들고, PR 상태를 확인한 뒤
   main에 머지한다. release-please 릴리즈 PR은 `Release-Platform: mac`
   trailer로 머지해 macOS 아티팩트만 발행한다.

## 안전 조건

- `disabled`와 `approval_required`의 기존 동작은 바꾸지 않는다.
- `ReadOnly` 연결에는 `execute_write`를 노출하지 않는다.
- 모든 쓰기에도 기존 MCP database/schema/table scope를 적용한다.
- 테스트는 개인/운영 DB를 변경하지 않고 임시 SQLite DB만 사용한다.
