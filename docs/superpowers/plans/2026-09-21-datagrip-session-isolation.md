# DataGrip 스타일 쿼리 세션 격리 계획

## 목표

연결 프로필의 권한과 쿼리탭의 실행 상태를 DataGrip의 Data Source → Session → Client 모델에 가깝게 분리한다.

## 범위

- 연결 프로필의 `readOnly`를 모든 쿼리 실행 경로에서 강제한다.
- 같은 연결의 쿼리탭마다 Read-only/Write 모드를 독립적으로 보유한다.
- 쿼리탭별 수동 트랜잭션 세션과 권한 모드를 유지하고, 탭 전환으로 상태가 섞이지 않게 한다.
- Read-only 연결에서는 Write 전환과 쓰기 실행 UI를 차단한다.
- 배치 실행 및 보조 DDL 실행 경로도 연결 프로필 정책을 통과하게 한다.
- 쿼리탭에 현재 연결의 Read-only 상태와 탭별 세션/트랜잭션 상태를 명확히 표시한다.

## 비범위

- 여러 쿼리탭이 하나의 세션을 공유하는 DataGrip의 선택형 공유 모드
- 새로운 DB 드라이버 추가
- 기존 사용자 데이터 마이그레이션

## 구현 순서

1. Renderer 순수 상태 전이 테스트를 먼저 추가한다.
2. QueryEditor의 Write 상태를 탭 상태로 이동하고 연결 Read-only를 전달한다.
3. Engine 배치 정책 테스트를 추가하고 profile Read-only/SafeMode를 적용한다.
4. 실제 Electron E2E에서 같은 연결의 탭별 모드 독립성과 Read-only 차단을 검증한다.
5. 전체 renderer/engine 테스트와 빌드를 실행한다.

## 완료 기준

- 탭 A를 Write로 바꿔도 탭 B는 Read-only로 남는다.
- Read-only 연결에서는 어떤 탭에서도 Write 실행이 허용되지 않는다.
- 배치/DDL/일반 쿼리 경로가 동일한 연결 정책을 사용한다.
- 실제 앱 조작으로 위 동작을 확인하고 회귀 테스트를 남긴다.
