# AWS SSM 연결

MySQL·PostgreSQL 연결의 **접속 경로 → AWS SSM (EC2 경유)**를 선택하면
Rebase 엔진이 로컬 터널을 열고 EC2를 통해 DB에 접속합니다.

## 준비

- 로컬 머신에 AWS CLI와 `session-manager-plugin` 설치.
- 기존 AWS profile/SSO 설정 사용. SSO가 만료되면 터미널에서
  `aws sso login --profile production`처럼 지정한 profile에 로그인.
- EC2가 SSM 관리형 노드로 연결되어 있어야 하며, 원격 호스트 포트 전달을
  지원하는 SSM Agent와 EC2에서 DB로 향하는 DNS/네트워크 접근이 필요.
- AWS 사용자는 해당 EC2와 선택한 SSM 문서에 대한 세션 시작 권한이 필요.
  문서를 별도로 지정하지 않으면 `AWS-StartPortForwardingSessionToRemoteHost` 사용.
- 자신이 시작한 세션에 대한 `ssm:TerminateSession` 권한도 필요합니다.
  로컬 CLI 종료만으로 원격 세션 종료를 보장할 수 없습니다.

AWS 설정 및 요구 사항:
[Session Manager 원격 호스트 포트 전달](https://docs.aws.amazon.com/ko_kr/systems-manager/latest/userguide/session-manager-working-with-sessions-start.html#sessions-remote-port-forwarding).

## 연결 설정

1. 새 연결 또는 연결 수정에서 MySQL/PostgreSQL을 선택.
2. 접속 경로에서 **AWS SSM (EC2 경유)** 선택.
3. AWS profile(선택), region, 경유 EC2 instance ID 입력.
4. Host·Port에는 EC2에서 접근할 **실제 DB 주소와 포트** 입력.
   로컬 포트나 EC2 주소를 DB Host로 입력하지 않음.
5. 기존 DB database·username·password·TLS 설정 입력 후 **Test** 실행.
6. 성공 후 저장. SSM 연결은 목록에 `SSM · DB주소:포트`로 표시.

AWS profile을 비우면 AWS CLI 기본 credential chain을 사용합니다.
AWS 자격증명은 Rebase에 복사하지 않으며 DB 비밀번호는 기존 OS Keychain에
저장합니다. SSM은 네트워크 경로 설정이므로 RDS IAM DB 인증을 자동으로
추가하지 않습니다.

## 사용자 정의 SSM 문서

`Revisit-RdsPortForwarding`처럼 DB 목적지가 문서에 정의되어 있고,
`localPortNumber`만 전달하는 기존 명령도 연결 설정으로 등록할 수 있습니다.

1. 접속 경로: **AWS SSM (EC2 경유)**.
2. AWS profile: `default`, AWS region: `ap-northeast-2`, EC2 instance ID: 기존 명령의 `--target` 값.
3. **SSM document**: `Revisit-RdsPortForwarding`.
4. **DB 목적지 설정 → SSM 문서에서 지정**.
5. DB 이름·계정·비밀번호·TLS 입력 후 **Test**와 저장.

이 모드에서는 Host·Port 입력을 숨기고 `host`, `portNumber`를 전달하지 않습니다.
연결하거나 쿼리를 실행하면 Rebase가 세션을 시작하고 준비된 터널에 DB 연결을
이어 붙입니다. 터미널에서 명령을 먼저 실행할 필요가 없으며 MCP도 같은 저장
설정을 사용합니다. 로컬 포트는 엔진마다 자동 할당하므로 예문의 `13306`을
DB 설정에 입력하지 않습니다. 문서는 전달된 `localPortNumber`를 로컬 포트로
사용하는 포트 전달 세션이어야 합니다.

사용자 정의 문서가 `host`, `portNumber`도 받는 경우에는 문서 이름을 입력하고
**DB Host·Port 직접 지정**을 유지합니다. 기본값은 AWS 표준 문서와 기존 방식이며,
문서 이름과 목적지 설정은 기존 프로필 JSON에 저장하므로 추가 migration은 없습니다.
AWS 문서·파라미터 형식: [StartSession API](https://docs.aws.amazon.com/systems-manager/latest/APIReference/API_StartSession.html),
포트 전달 세션 형식: [Session document schema](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-schema.html).

## 동작과 수명

엔진이 가용 로컬 포트를 선택하고 AWS CLI를 shell 없이 실행합니다.
플러그인의 포트 준비 메시지와 TCP 연결 가능 여부를 확인한 뒤 DB driver에
loopback endpoint를 전달합니다. 같은 프로필·목적지·AWS 설정의 동시 요청은
하나의 터널을 사용합니다.
사용자 정의 문서 이름 또는 목적지 설정이 달라지면 별도의 터널로 처리합니다.

터널 프로세스가 종료되면 다음 새 DB 연결에서 새 터널을 시작합니다.
실패한 SQL이나 끊긴 수동 트랜잭션은 재실행하지 않습니다. 엔진 종료,
프로필 수정·삭제 시 터널과 하위 프로세스를 정리합니다. 저장 전의 연결
테스트는 테스트가 끝나면 터널을 정리합니다. UI에서 연결 패널을 닫아도
엔진은 재사용할 터널을 유지할 수 있습니다.

플러그인의 시작 출력에서 SessionId를 추적하고, 터널 정리 시 시작할 때의
AWS profile·region으로 해당 ID에만 `aws ssm terminate-session`을 호출합니다.
시작 실패·취소 및 CLI의 예상치 못한 종료에도 같은 정리를 수행합니다.
출력 버퍼가 순환해도 소유한 ID를 유지하며, 다른 사용자/엔진의 세션을 조회하거나
일괄 종료하지 않습니다. 원격 종료는 요청 취소와 독립적으로 최대 5초 동안
시도하고, 실패하면 CLI 원문 없이 엔진 stderr에 권한·인증·네트워크 확인 안내를 남깁니다.
Desktop은 로컬 프로세스 정리와 원격 종료를 위해 엔진에 최대 10초의 종료 유예를 줍니다.
Electron도 종료 이벤트를 보류하고 이 정리가 끝난 뒤 앱을 닫습니다.

AWS도 세션의 명시적 종료를 권장합니다:
[End a session](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-sessions-end.html).
목록에 Active 세션이 많다는 사실만으로 인스턴스 자원 고갈이나 새 연결 실패의
원인을 확정할 수는 없습니다. 기존 잔여 세션은 소유자·대상·시작 시각을 확인한 뒤
별도로 정리해야 하며, 이 변경은 과거 세션을 자동 정리하지 않습니다.

## MCP

SSM 설정을 저장하고 연결의 MCP 노출을 켠 뒤 기존 MCP 연결 절차를 사용합니다.
추가 AWS 설정을 MCP 클라이언트에 복사할 필요가 없습니다. 클라이언트가 실행하는
로컬 엔진은 자체 포트를 할당하므로 Rebase UI 없이도 조회가 가능합니다.
Desktop 엔진과 MCP 엔진은 각자 터널을 소유하며 포트를 공유하지 않습니다.
SSM stdout/stderr는 MCP JSON-RPC stdout에 전달하지 않습니다.

기존 MCP 접근 범위·read-only·쓰기 승인 정책이 그대로 적용됩니다.
여기서 지원하는 MCP는 **동일 머신에서 실행되는 로컬 stdio MCP**입니다.
클라우드 MCP 서버 배치는 별도 기능입니다.

## 오류 및 제한

연결 테스트는 CLI/plugin 미설치, SSO 만료, IAM 거부, EC2 미연결 및 시작
timeout을 안내합니다. SSM 오류 시 직접 DB 접속으로 자동 우회하지 않습니다.
CLI 원문 출력은 보관하거나 UI/MCP에 노출하지 않고 정해진 오류 안내로 변환합니다.

MCP 엔진은 stdin EOF와 SIGTERM 종료 요청을 처리하며, stdin이 열린 상태에서도
종료할 수 있습니다. 여러 터널은 동시에 정리하고, CLI보다 오래 살아 있는
플러그인도 프로세스 그룹에서 정리합니다(macOS의 하위 프로세스 테스트로 검증).
엔진 자체의 SIGKILL/충돌, SessionId가 출력되기 전 중단, AWS 권한 부족이나
네트워크 단절 시에는 원격 종료를 보장하지 못합니다. 소유 ID는 메모리에만
유지하므로 이런 경우 AWS에서 잔여 세션 확인이 필요합니다.

TLS 설정은 기존 connector 설정을 사용합니다. CA bundle 및 실제 DB 호스트명에
대한 엄격한 인증서 검증 설정과 RDS IAM 토큰 생성·갱신은 별도 범위입니다.

## 검증

`apps/desktop/e2e/ssm.spec.ts`는 격리된 metadata/user-data, 일회용 AWS CLI
대역 프로세스와 로컬 DB를 사용해 폼, 쿼리, 터널 재사용·종료·재시작 및
별도 MCP 엔진을 검증합니다. MySQL이 없으면 해당 흐름을 skip합니다.
AWS 대역은 로컬 프로세스가 종료돼도 원격 세션 장부를 유지하고 명시적인
TerminateSession 호출만으로 지웁니다. 따라서 포트 종료와 원격 종료를 각각
검증합니다. 연결 준비 실패의 반복 정리는 DB가 없는 환경에서도 실행합니다.
PostgreSQL은 기본 `127.0.0.1:5432` 또는 `E2E_SSM_POSTGRES_PORT`, 사용자
`postgres`, 비밀번호 `E2E_SSM_POSTGRES_PASSWORD`(기본 `postgres`)를 사용하며
없으면 skip합니다. 실제 AWS IAM/SSO/SSM 네트워크는 권한이 있는 테스트
환경에서 별도로 확인해야 합니다.

배포 전 검증에는 MySQL/PostgreSQL의 연결 진입점 15개씩에 대한 공통 라우팅
계약 테스트, 실제 하위 프로세스의 타임아웃·동시 요청·종료 테스트, 명령 인수
fuzzing, 기존 프로필 마이그레이션 보존 및 MCP 입력 대기 중 취소 테스트도
포함합니다. E2E는 배치·수동 쿼리, 끊긴 트랜잭션의 재실행 방지, Desktop/MCP
동시 사용과 EOF/SIGTERM 종료를 확인합니다. Windows/Linux는 cross-build를
확인했으며 해당 OS의 실제 실행 검증은 별도로 필요합니다.
