# SSH bastion 연결

MySQL·PostgreSQL 연결에서 **접속 경로 → SSH (Bastion 경유)**를 선택합니다.
터미널에서 터널을 먼저 만들 필요 없이 Rebase가 연결 테스트와 DB 요청에 맞춰 터널을 엽니다.

1. Bastion Host: EC2의 DNS 이름 또는 IP 주소.
2. SSH Port: 기본 22, SSH User: 예를 들어 `ec2-user`.
3. SSH 개인 키 파일: **키 파일 선택**으로 암호가 없는 PEM/OpenSSH 개인 키를 선택.
4. known_hosts 파일: 기본 `~/.ssh/known_hosts`; 별도 파일이 있으면 지정.
5. DB Host·Port: bastion에서 접근할 실제 RDS 주소와 포트(예: 3306).
6. DB 이름·계정·비밀번호·TLS 설정 후 **Test**와 저장.

첫 연결 전에 서버 관리자가 제공한 호스트 키 지문과 대조하여 bastion을
OpenSSH `known_hosts`에 등록해야 합니다. 일반 SSH 클라이언트에서 확인하여
등록한 파일을 사용할 수 있습니다. Rebase는 알 수 없거나 변경된 호스트 키를
자동으로 신뢰하지 않으며 오류를 반환합니다. `ssh-keyscan` 출력만으로 신뢰를
결정하지 마세요. 별도 포트의 known_hosts 항목은 `[호스트]:포트` 형식입니다.

프로필에는 bastion 설정과 파일 경로만 저장합니다. 키 본문은 엔진에서만 읽으며
DB 비밀번호는 기존 OS Keychain을 사용합니다. 키 파일을 이동하면 경로를 갱신해야 합니다.
`~/` 경로도 사용할 수 있습니다. 암호화된 키, SSH 비밀번호, SSH agent 및 ProxyJump는
이번 버전에서 지원하지 않습니다. AWS CLI나 SSM 설정은 필요하지 않습니다.

엔진은 SSH 호스트 키 검증과 인증, bastion에서 DB로의 접속 확인 후
`127.0.0.1`의 임의 포트를 할당합니다. 같은 프로필·SSH 설정의 요청은 터널을
공유합니다. SSH 연결이 끊기면 다음 새 DB 요청에서 재연결하며 실패한 SQL과
수동 트랜잭션을 자동으로 재실행하지 않습니다. 프로필 수정·삭제와 엔진 종료 시
SSH 연결, 로컬 listener 및 활성 forwarding socket을 닫습니다.
저장 전 연결 테스트의 터널도 테스트 종료 시 정리합니다.

SSH는 bastion까지의 전송을 암호화합니다. bastion→DB 구간의 암호화는
기존 DB TLS 설정을 따르며 서버 인증서 검증 수준을 강화하지 않습니다.
MCP도 동일한 저장 프로필의 SSH 경로와 기존 query/access 정책을 사용합니다.

## 회귀 검증

```bash
go test -race ./engine/internal/adapters/ssh
pnpm build
pnpm --filter desktop exec playwright test ssh.spec.ts
```

E2E는 실제 로컬 SSH 테스트 서버를 만들고 프로필 저장소와 Electron 사용자
데이터를 임시 디렉터리로 격리합니다. 운영 bastion/RDS에는 연결하지 않습니다.
로컬 MySQL·PostgreSQL이 없으면 해당 DB 흐름을 skip합니다. 별도 테스트 포트는
`E2E_SSH_MYSQL_PORT`, `E2E_SSH_POSTGRES_PORT`, 비밀번호는 각각
`E2E_SSH_MYSQL_PASSWORD`, `E2E_SSH_POSTGRES_PASSWORD`로 지정합니다.
기본 DB 설정은 MySQL `devdb`/`root`, PostgreSQL `postgres`/`postgres`입니다.
Go 실행 파일의 경로가 PATH에 없다면 `REBASE_GO_BINARY`로 지정할 수 있습니다.
