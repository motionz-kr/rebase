# 연결 편집 시 자격증명 보존 플랜

## 문제

연결 프로필을 편집할 때 renderer가 `secretRef` 없는 프로필을 전송한다. 비밀번호 입력을 비워 기존 비밀번호를 유지하려는 경우, application service가 빈 `secretRef`를 저장해 OS keychain의 기존 비밀번호와 프로필의 연결을 끊는다. 이후 연결 시 keychain 조회가 실패해 빈 비밀번호로 접속하면서 `authentication failed: invalid username or password`가 발생한다.

## 구현 순서

1. `ConnectionService.UpdateProfile` 테스트에 비밀번호를 비운 편집 요청이 기존 `secretRef`를 보존하고 기존 비밀번호로 조회되는 실패 케이스를 추가한다.
2. application service가 저장된 기존 프로필을 읽어 `secretRef`를 보존하도록 최소 수정한다. 새 비밀번호가 있을 때만 기존 secret을 교체한다.
3. renderer의 편집 저장 경로가 보존되는지 Desktop E2E 핵심 흐름을 추가한다. 격리된 로컬 MySQL에 연결 프로필을 만들고 비밀번호 없이 편집 저장한 뒤 연결을 끊었다가 다시 연결해 실제 Electron → engine → keychain/store → renderer 경로를 확인한다. MySQL이 없는 환경에서는 규칙에 따라 테스트를 skip한다.
4. Go unit/application 테스트, renderer/desktop 빌드 및 관련 Playwright E2E를 실행한다.

## 안전성

- 비밀번호는 계속 OS keychain에만 저장한다.
- 기존 secret이 없는 프로필의 편집은 임의의 빈 secret을 만들지 않고 현재 동작대로 비밀번호 재입력을 요구한다.
- 사용자의 실제 프로필이나 운영 DB를 사용하지 않고 E2E 격리 DB만 사용한다.
