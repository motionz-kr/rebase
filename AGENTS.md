# AGENTS.md — 에이전트 작업 규칙 (내부 고정 규칙)

이 파일은 이 저장소에서 작업하는 모든 에이전트가 **반드시** 따르는 규칙이다.
상세 배경은 아래 문서를 참조한다(여기서 중복 설명하지 않는다).

- 아키텍처: [`docs/architecture.md`](docs/architecture.md)
- 개발 원칙(Clean Architecture, TDD, layer 규칙): [`docs/development-principles.md`](docs/development-principles.md)
- 테스트 전략(테스트 계층, Desktop E2E): [`docs/testing-strategy.md`](docs/testing-strategy.md)
- 보안/정책: [`docs/security.md`](docs/security.md)

---

## 0. 절대 규칙 — 기능 구현 후 실제 조작 검증

> **모든 기능은 만든 뒤 반드시 실제로 앱을 띄워 직접 조작해 검증한다. 단위 테스트 통과만으로는 "완료"가 아니다.**

- UI나 런타임 동작에 영향을 주는 변경은 **Playwright E2E**(권장) 또는 **CDP 직접 조작**으로
  실제 실행 경로(Electron → engine → DB → renderer)를 눈으로 확인한 뒤에만 완료로 간주한다.
- 재현 가능한 흐름은 Playwright 스펙으로 **고정(회귀 방지)** 한다: `apps/desktop/e2e/`.
  일회성 CDP 검증으로 끝내지 말고, 핵심 user flow면 E2E 스펙을 추가한다.
- "테스트가 통과하니 됐다"는 금지. 실제 조작에서 보이는 동작이 최종 판단 기준이다.
  (이전에 unit test는 통과했지만 라이브에서 깨진 사례: MySQL `ESCAPE '\'`, sort NULL 처리 등.)

### E2E 실행

```bash
pnpm --filter desktop test:e2e      # 전체 (smoke + 실제 flow + 편집 flow)
pnpm --filter desktop exec playwright test <file>   # 개별
```

### E2E 작성 규칙 (격리·안전)

- **개인/운영 DB의 실제 데이터를 변경하지 않는다.** 로컬 dev DB(`127.0.0.1:3306` 등)는
  쓰되, 쓰기 검증은 테스트가 직접 만들고 지우는 **일회용 테이블**에서만 한다(`e2e_*`).
- engine 프로필 저장소는 **반드시 격리**한다. fixture가 `ENGINE_DB_PATH`(임시 metadata.db) +
  `--user-data-dir`(임시) + `ENGINE_BINARY_PATH`(unpackaged 엔진 경로)를 주입한다.
  → 실제 `~/.antigravity/metadata.db`를 절대 건드리지 않는다.
- DB가 없으면 `isPortOpen()`으로 **우아하게 skip**한다(하드 실패 금지).
- 시드/검증은 `apps/desktop/e2e/db.ts`(mysql2)로 권위 있게 확인한다.
- 검증 중 데이터를 건드렸다면 **원상 복구**한다(테이블 DROP, 행 복원).

---

## 1. TDD (RED → GREEN → REFACTOR)

- 순수 로직(SQL 빌더, 파서, 분류기, 그리드 변환 등)은 **반드시 실패 테스트 먼저** 작성한다.
- 순서: 실패 테스트 → 실패 이유 확인 → 최소 구현 → 통과 확인 → 정리.
- 렌더러 순수 모듈은 `apps/renderer/src/lib/*.ts` + 인접 `*.test.ts` (vitest).
- 엔진은 domain unit → application use case(fake port) → adapter contract → integration 순.
- 자세한 흐름/예시는 [`docs/development-principles.md`](docs/development-principles.md) "TDD Workflow".

## 2. Clean Architecture / Ports & Adapters

- dependency rule을 지킨다. `domain`은 driver/HTTP/Electron/logger/SQLite를 import하지 않는다.
- DB driver 차이는 **adapter에 가둔다**. driver-specific type/error를 밖으로 노출하지 않는다.
- `SQLConnector` 인터페이스에 메서드를 추가할 때는 **두 adapter(mysql, postgres)에 먼저 구현**한 뒤
  인터페이스 + transport + route 순으로 연결한다(빌드 깨짐 방지).
- UI(renderer)는 application policy(쓰기 허용·destructive 판단)를 재구현하지 않는다.
- layer별 허용/금지 목록은 [`docs/development-principles.md`](docs/development-principles.md) "Layer별 규칙".

## 3. 기능당 작업 흐름 (고정)

1. 설계 → `docs/superpowers/plans/YYYY-MM-DD-<name>.md` 플랜 작성.
2. feature 브랜치 생성(`feat/<name>`). 기본 브랜치에서 바로 커밋하지 않는다.
3. 순수 로직은 TDD(RED+GREEN)로 구현. IO/UI는 얇게 연결.
4. **0번 규칙대로 라이브 검증**(Playwright/CDP) — 통과 확인.
5. 검증 중 변경한 사용자 데이터/DB는 원상 복구.
6. `git merge --no-ff`로 `main`에 머지. 커밋은 작게, 무관한 리팩터링과 섞지 않는다.

## 4. 빌드/실행 메모

- 렌더러 변경은 vite HMR(5173)로 자동 반영.
- **engine(Go)** 변경: `pnpm build:engine` 후 Electron 재시작.
- **desktop main/preload(TS)** 변경: `pnpm --filter desktop build`(tsc) 후 재시작.
- E2E는 prod 렌더러(`ELECTRON_IS_DEV=0`, `base:'./'`)로 로드되므로
  `pnpm --filter renderer build`가 최신이어야 한다.

## 5. 커밋

- 커밋/푸시는 요청받았을 때만. 기본 브랜치면 먼저 브랜치를 판다.
- 커밋 메시지 끝에 공동 작성자 명시:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- 문서 갱신이 필요한 변경(layer boundary, storage/secret/query policy, 지원 DB 추가, packaging 등)은
  코드와 함께 문서도 갱신한다.
