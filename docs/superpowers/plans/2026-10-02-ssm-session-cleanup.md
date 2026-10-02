# SSM 원격 세션 종료 누락 수정

## 확인한 문제

SSM manager는 로컬 CLI/plugin 프로세스 트리만 종료한다. AWS의 원격 세션을
명시적으로 종료하지 않아 MCP 엔진 재실행/연결 테스트마다 세션이 남을 수 있다.
운영 세션 수와 연결 장애의 인과관계는 별도이며 이번 검증에서는 운영 AWS/DB에 접근하지 않는다.

## 설계

- 플러그인 시작 출력에서 소유한 SessionId를 청크 경계와 출력 버퍼 순환에 안전하게 추적한다.
- 정상 종료, 시작 실패/취소, 예상치 못한 CLI 종료 모두에서 해당 ID만 `ssm terminate-session`으로 종료한다.
- 시작할 때 사용한 AWS 실행 파일, profile, region을 유지한다. 종료 context는 요청 취소와 독립적이다.
- 로컬 프로세스 정리와 원격 종료는 중복 없이 실행하고 원격 호출에는 제한 시간을 둔다.
- 원격 종료 실패는 민감한 CLI 출력을 노출하지 않는 stderr 진단으로 알린다.
- Desktop 종료 유예 시간을 원격 정리 예산과 맞춘다. 같은 엔진의 반복 조회는 기존 터널을 계속 재사용한다.
- Electron `will-quit` 이벤트에서 비동기 정리가 끝날 때까지 종료를 보류한다.
- 엔진 강제 종료/네트워크 장애/권한 부족의 한계와 `ssm:TerminateSession` 권한을 문서화한다.

## 검증 순서

1. SessionId 파싱과 실제 대역 subprocess 종료 계약 테스트를 먼저 추가하고 RED 확인.
2. 최소 구현 후 Go 테스트와 race 검사.
3. 격리된 Electron E2E의 AWS 대역을 원격 세션 장부로 확장한다. 로컬 프로세스 종료만으로 장부가 정리되지 않게 한다.
4. 실제 앱에서 연결 테스트, 조회/반복 MCP 조회, 프로필 변경, EOF/SIGTERM/앱 종료 후 소유 세션 종료를 검증한다.
5. 로컬 DB가 없으면 관련 flow를 skip하고, DB 없이 가능한 실패 경로도 실제 앱에서 검증한다.

## 작업 경계

기존 query-tab-context-menu 작업 파일은 수정하지 않는다. 요청 없는 커밋/푸시/머지는 하지 않는다.

## 검증 결과

- RED: 소유 세션 ID 보존, 정상/실패/취소/예상치 못한 종료의 원격 종료 호출 누락을 Go 테스트로 확인.
- RED: 실제 Electron의 연결 준비 실패 후 원격 종료 장부 0건을 확인.
- RED: 종료 API를 3.5초 지연시키면 Electron이 원격 정리 전에 닫히는 문제를 확인.
- GREEN: `go test -race ./engine/internal/adapters/ssm -count=1` 통과.
- GREEN: Desktop engine lifecycle 테스트 3개 통과. engine/renderer/desktop 빌드 통과.
- GREEN: `E2E_SSM_POSTGRES_PORT=25483 pnpm --filter desktop exec playwright test ssm.spec.ts`
  4개 통과, 로컬 MySQL 부재로 2개 skip. PostgreSQL은 임시 디렉터리/별도 포트로 직접 띄운 일회용 인스턴스 사용.
- 실제 화면에서 사용자 정의 문서 연결 성공과 SELECT 결과를 확인.
- MCP 10회 조회의 터널 재사용, EOF/SIGTERM 정리, Desktop/MCP 소유권 분리,
  원격 API 지연 시 앱 종료 대기, 생성 세션 전부에 대한 정확히 한 번의 종료를 확인.
- 운영 AWS/DB와 기존 56개 세션에는 접근하거나 변경하지 않음. 실제 AWS 권한/네트워크 검증과 배포는 별도.
