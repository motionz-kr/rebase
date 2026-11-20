# GCP Cloud SQL 연결

MySQL·PostgreSQL·SQL Server 연결의 **접속 경로 → GCP Cloud SQL (cloud-sql-proxy)**를
선택하면 Rebase 엔진이 로컬에서 `cloud-sql-proxy`를 띄우고, 그 loopback 포트로
DB에 접속합니다. 인스턴스 연결 이름(`project:region:instance`)만 저장하며 DB의
IP·포트는 입력하지 않습니다.

## 준비

- 로컬 머신에 **cloud-sql-proxy v2** 설치. 예: `gcloud components install cloud-sql-proxy`
  또는 `brew install cloud-sql-proxy`. 엔진은 PATH, `/opt/homebrew/bin`,
  `/usr/local/bin`, `~/.local/bin`, gcloud SDK의 `bin` 등에서 자동으로 찾습니다.
  다른 위치에 있으면 폼의 **cloud-sql-proxy 경로**에 절대 경로를 입력합니다.
- 기본 인증은 gcloud 사용자 로그인입니다. 터미널에서 `gcloud auth login`을 실행합니다.
  이 모드에서는 `gcloud`가 엔진 프로세스에서 실행 가능해야 합니다(PATH 또는 위 고정 경로).
- 사용하는 계정(사용자 또는 서비스 계정)에 대상 프로젝트의
  **`roles/cloudsql.client`** 권한이 필요합니다.
- Private IP 인스턴스는 이 머신이 해당 VPC에 접근할 수 있어야 합니다(VPN 등).
- 연결 테스트는 `--run-connection-test` 플래그를 사용하므로, 이 플래그를 지원하는
  cloud-sql-proxy v2 릴리스가 필요합니다. 더 오래된 버전은 "최신 버전이 필요합니다"
  안내가 표시됩니다.

## 연결 설정

예: PostgreSQL 15 인스턴스의 `cs_intelligence` 데이터베이스.

1. 새 연결 또는 연결 수정에서 MySQL/PostgreSQL/SQL Server를 선택.
2. 접속 경로에서 **GCP Cloud SQL (cloud-sql-proxy)** 선택.
3. **인스턴스 연결 이름**에 `project:region:instance` 입력
   (콘솔의 인스턴스 개요 → "연결 이름").
4. **인증 방식** 선택(아래 참고). 필요하면 **Private IP로 연결**과
   **cloud-sql-proxy 경로**를 지정.
5. Host·Port는 표시되지 않습니다. 엔진이 로컬 포트를 자동으로 할당합니다.
6. DB 이름(예: `cs_intelligence`)·계정·비밀번호를 입력하고 **Test** 실행.
7. 성공 후 저장. 목록에는 `Cloud SQL · project:region:instance`로 표시.

DB 비밀번호는 기존처럼 OS Keychain에 저장합니다. 인스턴스 연결 이름은
`project:region:instance` 형식(도메인 범위 프로젝트는 `domain.com:project:region:instance`)만
허용합니다.

TLS는 **None 또는 Prefer**만 사용할 수 있습니다(기본값 None). 로컬 구간
(Rebase → proxy)은 평문 loopback이고, proxy가 Google 측까지 암호화합니다.
**Require**는 UI에서 비활성화되며, 이전에 저장된 `require` 값은 편집 시 `none`으로
정규화됩니다. 엔진은 API 클라이언트가 직접 보내는 `require`를 거부합니다.

## 인증 방식

| 방식 | 동작 |
|------|------|
| gcloud 사용자 로그인 (기본) | `--gcloud-auth`. `gcloud auth login`으로 로그인한 계정 사용. |
| Application Default Credentials | 인증 플래그 없음. `gcloud auth application-default login` 또는 `GOOGLE_APPLICATION_CREDENTIALS` 등 ADC 체인 사용. |
| 서비스 계정 키 파일 | `--credentials-file <경로>`. **절대 경로**만 저장하며 키 내용은 읽거나 저장하지 않습니다. |

## Private IP

**Private IP로 연결**을 켜면 `--private-ip`로 시작합니다. 인스턴스에 Private IP가
없으면 Private IP 안내가 표시됩니다. 이 네트워크에서 도달할 수 없는 경우에는
Private IP 안내, 일반 연결 오류 안내, 시작 시간 초과 안내 중 하나로 나타날 수 있습니다.
Public IP로 자동 우회하지 않습니다.

## 동작과 수명

엔진이 가용 로컬 포트를 선택하고 cloud-sql-proxy를 shell 없이 직접 실행합니다
(`--address 127.0.0.1 --port <n> --run-connection-test <인스턴스>`).
cloud-sql-proxy는 지연 연결(lazy)이라 인스턴스 이름이 틀려도 "ready"까지 가므로,
엔진은 `--run-connection-test`의 `Connection test passed` 로그와 로컬 포트의
TCP 연결 가능 여부를 확인한 뒤에만 DB driver에 loopback endpoint를 전달합니다.
같은 프로필·설정의 동시 요청은 하나의 proxy를 공유하며, 시작 제한 시간은 30초입니다.

proxy가 종료되면 다음 새 DB 연결에서 새로 시작합니다. 실패한 SQL이나 끊긴 수동
트랜잭션은 재실행하지 않습니다. 프로필 수정·삭제 시 해당 proxy를 닫고, 목록의 **Disconnect**(열린 세션 정리 후)도
해당 프로필의 proxy/터널을 닫습니다. 같은 프로필 ID의 설정이 바뀐 요청이 오면 이전
설정의 proxy는 종료하고 새 proxy를 시작합니다(다른 프로필은 영향받지 않음). 저장된
프로필의 연결 테스트는 임시 소유 ID를 사용하므로 활성 연결의 proxy를 건드리지 않습니다.
 다음 요청에서
새 설정으로 다시 시작합니다(열려 있던 쿼리 탭은 다시 연결해야 할 수 있습니다).
엔진 종료 시 모든 proxy와 하위 프로세스를 정리합니다. 저장 전 연결 테스트의
proxy는 테스트가 끝나면 정리합니다.

proxy 출력은 엔진 stdout/stderr, UI, MCP로 전달하지 않습니다.
키 파일은 경로만 저장하고 토큰·키 내용은 저장하지 않습니다.

## 오류 안내

proxy 원문 출력(토큰·경로 포함 가능)은 노출하지 않고 아래 안내로 변환합니다.

| 상황 | 안내 |
|------|------|
| proxy 미설치 | Cloud SQL: cloud-sql-proxy를 찾을 수 없습니다. gcloud components install cloud-sql-proxy 또는 brew install cloud-sql-proxy 로 설치하거나 실행 파일 경로를 지정하세요 |
| 지정한 경로 실행 불가 | Cloud SQL: 지정한 cloud-sql-proxy 경로를 실행할 수 없습니다 |
| proxy 버전이 오래됨(알 수 없는 플래그) | Cloud SQL: cloud-sql-proxy v2 최신 버전이 필요합니다. gcloud components update 또는 재설치 후 다시 시도하세요 |
| gcloud 로그인 만료 | Cloud SQL: gcloud 로그인이 만료되었습니다. 터미널에서 gcloud auth login 을 실행하세요 |
| ADC 없음 | Cloud SQL: Application Default Credentials가 없습니다. gcloud auth application-default login 을 실행하거나 인증 방식을 바꾸세요 |
| 키 파일 읽기 실패 | Cloud SQL: 서비스 계정 키 파일을 읽지 못했습니다. 경로와 권한을 확인하세요 |
| IAM 권한 부족 | Cloud SQL: IAM 권한이 부족합니다. 대상 프로젝트에 roles/cloudsql.client 권한이 필요합니다 |
| 인스턴스/프로젝트 없음 | Cloud SQL: 인스턴스를 찾을 수 없습니다. 인스턴스 연결 이름(project:region:instance)을 확인하세요 |
| Private IP 없음/도달 불가 | Cloud SQL: 인스턴스에 Private IP가 없거나 이 네트워크에서 접근할 수 없습니다. Private IP 설정을 확인하세요 |
| 시작 시간 초과·취소 | Cloud SQL Proxy 준비 시간이 초과되었거나 취소되었습니다. gcloud 인증과 인스턴스 상태를 확인하세요 |
| 그 외 | Cloud SQL Proxy를 시작하지 못했습니다. gcloud 인증, 인스턴스 이름과 네트워크 설정을 확인하세요 |

오류가 나도 직접 DB 접속으로 자동 우회하지 않습니다.

## MCP

Cloud SQL 설정을 저장하고 연결의 MCP 노출을 켠 뒤 기존 MCP 연결 절차를 사용합니다.
클라이언트가 실행하는 로컬 stdio 엔진이 필요할 때 자체 proxy를 시작하며
Rebase UI가 실행 중일 필요가 없습니다. Desktop 엔진과 각 MCP 엔진은 각자
proxy와 로컬 포트를 소유하며 공유하지 않습니다. proxy 로그는 MCP JSON-RPC
stdout에 전달하지 않습니다. MCP 엔진이 실행되는 머신에도 cloud-sql-proxy와
gcloud 인증이 있어야 합니다. 기존 MCP 접근 범위·read-only·쓰기 승인 정책이
그대로 적용됩니다.

## 별도 범위

- Cloud SQL IAM 데이터베이스 인증(자동 IAM 로그인)과 DB 계정 토큰 갱신은 지원하지 않습니다.
  DB 계정·비밀번호는 기존 방식입니다.
- 인스턴스 목록 조회·자동 완성은 없습니다. 인스턴스 연결 이름을 직접 입력합니다.
- Windows/Linux는 빌드·정적 검사만 확인했으며 실제 실행 검증은 별도로 필요합니다.
- 실제 Cloud SQL 인스턴스에 대한 라이브 검증은 아직 수행하지 않았습니다.

## 검증

`apps/desktop/e2e/gcp-cloudsql.spec.ts`는 격리된 metadata와 일회용 cloud-sql-proxy
대역 프로세스, 로컬 DB(MySQL, PostgreSQL)를 사용해 curated 오류, 폼(Host·Port 숨김,
인증 필드), 저장·목록 표시, 쿼리, 동시 요청의 proxy 재사용, 실행 인수, 기존 SSM/SSH
프로필 보존, 별도 MCP stdio 엔진(stdout 프로토콜 순수성, 독립 포트·종료)과
앱 종료 후 프로세스 잔존 여부를 확인합니다. 실제 GCP 인증·네트워크는 권한이 있는
환경에서 별도로 확인해야 합니다.
