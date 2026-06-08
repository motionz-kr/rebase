# 도메인 이해 기반 DB Assistant — 설계

> Issue: #103 · Epic #107 · Milestone #8 (DB Tool v1)
> Date: 2026-06-08

## 배경 / 목표

일반 Database Tool은 테이블·컬럼·관계만으로 SQL 작성을 돕는다. 그러나 실무에서는 도메인 맥락
(예: 리비짓 `User`=환자, `Reception`=내원, `deletedAt IS NULL`=활성 데이터, `hospitalId`=병원 구분)이
더 중요하다. 사용자가 업무 자연어로 질문하면 이 도메인 맥락을 반영해 SQL을 생성·설명하도록 한다.

초기 버전은 완전 자동 실행이 아니라 "자연어 → SQL 초안 → 사용자가 검토 후 실행" 흐름을 우선한다.

## 핵심 결정 (brainstorming 확정)

1. **별도 어시스턴트를 새로 짓지 않는다.** 기존 AgentChat(도구 사용형 NL→SQL: 스키마 introspection
   15종, `propose_write`, 위험 배지, 스트리밍, provider 인증)이 이미 NL→SQL의 뼈대다. #103은
   **새 1차 자료(도메인 사전)를 만들고 그것을 기존 AgentChat에 주입**해 도메인 인지형으로 만든다.
2. **도메인 사전 = 용어사전 + 규칙노트.** 용어사전은 테이블/컬럼 → 업무 의미 항목 목록. 규칙노트는
   자유 서술 도메인 규칙(예: "항상 `deletedAt IS NULL`", "`hospitalId`로 범위 제한"). 자동 규칙
   근거는 #105의 tenant/soft_delete 바인딩을 재사용한다.
3. **사전 입력 = 스키마 자동 시드 + 주석, 추가로 AI 채우기.** 연결된 DB의 실제 테이블/컬럼을 불러와
   목록으로 제시하고 사용자가 의미만 채운다. 보조로 "AI로 채우기"(스키마 기반 의미 초안 제안, 또는
   사용자가 자연어로 서술하면 구조화)를 지원한다.
4. **SQL 설명 = 채팅 내 설명만.** 별도 에디터 버튼 없음(에이전트가 챗에서 자연어로 설명). YAGNI.
5. **진입점 = 기존 도메인 설정에 탭 통합.** 연결 메뉴 "도메인 설정"에서 역할 바인딩(#105) + 용어사전·
   규칙(#103)을 함께 접근.

## 아키텍처 개요

```
[도메인 사전 편집기] (연결별)                 [기존 AgentChat] (강화됨)
  · 스키마 자동 시드(테이블/컬럼)                ↑ system 프롬프트에 도메인 컨텍스트 주입
  · 의미 주석 (수동)                            │
  · "AI로 채우기" (자연어→구조화)        ──저장──→ profile.domainGlossary(JSON)
  · 자유 규칙노트                                      profile.domainNotes(text)
        │                                              + 기존 tenant/soft_delete 바인딩
        ▼                                              │
  profile 저장 ────────────────────────────────────────┘
                       엔진 /agent/run 핸들러가 profile 로드 →
                       buildDomainContext(glossary, notes, tenant, softDelete)
                       → svc.SetDomainContext() → system 프롬프트 끝에 append
```

기존 도구 루프·스트리밍·데이터노출 정책·secret redaction은 전부 그대로다. 추가되는 것은 (1) 프로필의
새 두 필드, (2) 도메인 컨텍스트 직렬화 1개 순수 함수, (3) system 프롬프트 append 1줄, (4) 편집기 UI다.

## 컴포넌트 설계

### A. 엔진 — 도메인 데이터 + 컨텍스트 주입

**A1. 프로필 필드 (`engine/internal/domain/connection.go`)**

```go
type ConnectionProfile struct {
    // ... 기존 필드 ...
    DomainGlossary string // JSON 배열: 테이블/컬럼 업무 의미
    DomainNotes    string // 자유 서술 도메인 규칙 텍스트
}

type DomainEntry struct {
    Kind    string `json:"kind"`    // "table" | "column"
    Table   string `json:"table"`   // 테이블명
    Column  string `json:"column"`  // 컬럼명 (table 항목은 빈 값)
    Meaning string `json:"meaning"` // 업무 의미
}

// 파서: 잘못된 JSON이면 빈 슬라이스(기존 DomainBindingMap 패턴과 동일하게 관대).
func (p ConnectionProfile) DomainGlossaryEntries() []DomainEntry
```

**A2. 마이그레이션 v9 (`engine/internal/adapters/.../sqlite` repo)**
- `ALTER TABLE connection_profiles ADD COLUMN domain_glossary TEXT NOT NULL DEFAULT ''`
- `ALTER TABLE connection_profiles ADD COLUMN domain_notes TEXT NOT NULL DEFAULT ''`
- 프로필 read/write에 두 필드 매핑.

**A3. 도메인 컨텍스트 직렬화 (`engine/internal/agent/domain_context.go`, 순수·TDD)**

```go
// 용어사전 + 규칙노트 + 바인딩을 한국어 system 블록으로 직렬화.
// 사전·노트·바인딩이 모두 비면 "" 반환(주입 생략 → 기존 동작 불변).
func BuildDomainContext(entries []domain.DomainEntry, notes string,
    tenantCols []string, softDelete string) string
```

출력 예:
```
## 도메인 맥락 (이 연결의 업무 의미)
다음 용어 의미를 반영해 질의를 해석하라:
- User (테이블) = 환자
- Reception (테이블) = 내원
- User.hospitalId (컬럼) = 병원 구분값
도메인 규칙:
- 항상 deletedAt IS NULL (활성 데이터)
- 특정 병원이 언급되면 hospitalId로 범위 제한
자동 적용 규칙(사용자가 명시적으로 해제하지 않는 한):
- soft-delete 컬럼 `deletedAt` 은 IS NULL 로 필터
- tenant 컬럼 hospitalId 로 범위 제한
지시: 쓰기/조회 SQL을 제안하기 전에, 네가 해석한 조건을 한국어 불릿 목록으로 먼저 제시하라.
```

**A4. AgentService 주입 (`engine/internal/agent/service.go`)**
- 필드 `domain string` + `SetDomainContext(s string)` 추가.
- `request()`에서 system 결합: `system + "\n\n" + domain` (domain도 `Redact` 통과).
- domain이 빈 문자열이면 결합 생략.

**A5. 핸들러 배선 (`engine/internal/transport/http/agent.go` Run)**
- 이미 로드한 `profile`에서:
  `svc.SetDomainContext(agent.BuildDomainContext(profile.DomainGlossaryEntries(), profile.DomainNotes, profile.TenantColumnList(), profile.DomainBindingMap()["soft_delete"]))`
- `/agent/complete`(#104)는 변경 없음(도메인 사전 채우기에는 별도로 사용 — C2 참고).

### B. 렌더러 — 순수 로직 (TDD)

**B1. `lib/domainGlossary.ts`**
```ts
export interface DomainEntry { kind: 'table' | 'column'; table: string; column: string; meaning: string; }
// 스키마(테이블+컬럼)를 기존 항목과 병합: 기존 의미 보존, 신규 항목은 빈 의미로 추가,
// 스키마에서 사라진 항목은 의미가 있으면 유지(고아 표시), 없으면 제거.
export function mergeSchema(existing: DomainEntry[], tables: string[], columnsByTable: Record<string,string[]>): DomainEntry[];
export function serializeGlossary(entries: DomainEntry[]): string; // 빈 의미 제외 후 JSON
export function parseGlossary(json: string | undefined): DomainEntry[]; // 관대한 파싱
```

**B2. `lib/domainFillPrompt.ts`**
```ts
// 스키마(+선택적 사용자 자연어 서술)로 /agent/complete 용 프롬프트 생성.
// 스키마명은 메타데이터만 — 행 데이터 미전송(프라이버시 게이트 불필요).
export function buildFillPrompt(tables: string[], columnsByTable: Record<string,string[]>, userText?: string): { system: string; user: string };
// AI 응답(JSON 기대)에서 제안 엔트리 추출. 파싱 실패 시 빈 배열.
export function parseFillResponse(text: string): DomainEntry[];
```

### C. 렌더러 — 컴포넌트 (빌드 검증)

**C1. `components/DomainDictionaryDialog.tsx` (또는 도메인 설정 탭)**
- 마운트 시: 저장된 glossary 로드 + 라이브 스키마(기존 introspection IPC: 테이블/컬럼) 로드 → `mergeSchema`.
- 테이블별 그룹 그리드: 테이블 행(의미 입력) + 그 아래 컬럼 행(의미 입력). 검색/필터 입력.
- "AI로 채우기" 버튼: (옵션) 자연어 서술 입력 → `buildFillPrompt` → `generateNarration` IPC 스트리밍
  (#104 `/agent/complete` 재사용) → `parseFillResponse` → 빈 의미 칸에 제안 채움(사용자 검토·수정).
  AI 미설정/실패 시 토스트, 수동 입력 유지.
- 규칙노트 `<textarea>`.
- 저장: `serializeGlossary` + notes → 프로필 업데이트 IPC(기존 `updateProfile` 재사용).

**C2. 진입점 통합 (`DomainBindingsDialog.tsx` 확장 또는 래퍼 `DomainSettingsDialog.tsx`)**
- 탭 2개: **역할 바인딩**(#105 기존 UI 재사용) + **용어사전·규칙**(C1).
- 연결 컨텍스트 메뉴 "도메인 설정" → 이 탭 다이얼로그.

### D. IPC / 저장

- 새 IPC 불필요 가정: 도메인 필드는 기존 프로필 update/get 경로에 두 필드를 추가해 실어 보낸다.
  (글로벌 타입 `ConnectionProfile`에 `domainGlossary?`, `domainNotes?` 추가.)
- AI 채우기는 #104의 `generateNarration`(→ `/agent/complete`) IPC를 그대로 사용(custom system/messages).

## 요구사항 매핑 (이슈 #103 완료기준)

- [x] 테이블/컬럼 의미 등록 → A1·B1·C1 도메인 사전 편집기
- [x] 자연어 → SQL → 기존 AgentChat + A3~A5 도메인 컨텍스트 주입
- [x] SQL 생성 전 해석 조건 제시 → A3 지시문("해석한 조건을 한국어 불릿로 먼저")
- [x] 기본 도메인 규칙 제안(`deletedAt IS NULL`, `hospitalId`) → A3 자동 적용 규칙 + #102 분석기 백스톱
- [x] 생성 SQL 자연어 설명 → 채팅 내 설명(기존 에이전트 동작)
- [x] 사용자가 검토 후 직접 실행 → 기존 propose_write / 실행 게이트 흐름 유지

## 에러 처리 / 엣지

- **빈 사전**: `BuildDomainContext`가 "" 반환 → 주입 생략 → 기존 AgentChat 동작 완전 불변.
- **잘못된 glossary JSON**: 파서가 빈 배열 폴백(엔진·렌더러 양쪽, 기존 관대 패턴).
- **AI 채우기 실패/미설정**: 토스트 안내, 수동 입력 유지(생성은 추가일 뿐 차단 아님).
- **스키마 로드 실패**: 편집기는 저장된 항목만 표시(시드 없이도 편집 가능).
- **스키마 변동(컬럼 삭제)**: 의미가 있던 항목은 유지(고아 표시), 빈 항목은 제거.

## 프라이버시 / 보안

- 용어사전·규칙노트·스키마명은 전부 **메타데이터**(행 데이터 아님). system 프롬프트 주입과 AI 채우기는
  dataExposure 정책과 무관하게 안전 — #104식 동의 게이트 불필요.
- 비밀번호/secret-ref는 기존 `Redact`가 system(+domain 블록) 및 메시지에서 계속 제거.

## 범위 경계

**포함(v1):** A~D.

**제외(v1, YAGNI):**
- 완전 자동 실행(검토 후 실행 흐름 유지).
- 에디터 임의 SQL "설명" 버튼(채팅 내 설명으로 충분).
- 도메인 사전의 버전관리/공유/내보내기.
- 비-SQL 엔진(Redis/Mongo) 도메인 사전 — v1은 SQL 연결 대상.
- FK 자동 추론 기반 JOIN 힌트 등 고급 추론(에이전트의 introspection 도구에 위임).

## 테스트 전략

- **순수 로직(Go/Vitest TDD)**: `BuildDomainContext`(사전·규칙·바인딩 직렬화, 빈 입력 시 "")
  / `mergeSchema`·`serializeGlossary`·`parseGlossary` / `buildFillPrompt`·`parseFillResponse`.
- **엔진 통합**: 마이그레이션 v9 + 프로필 repo 두 필드 read/write 왕복.
- **엔진 핸들러**: Run이 도메인 컨텍스트를 주입해도 빈 사전이면 기존과 동일(회귀 없음), 사전 있으면
  system에 블록 포함(stub provider로 확인).
- **렌더러 컴포넌트**: 빌드/타입체크(testing-library 없음).
- **CDP 라이브**: dev-mysql `erg_*` 임시 테이블에 용어 등록(예: `erg_user`=환자, `deletedAt`=삭제여부)
  → AgentChat에 "삭제 안 된 환자 찾아줘" → 생성 SQL에 `deletedAt IS NULL` 자동 포함 확인 + 해석 조건
  불릿 선표시 확인. AI 채우기 경로(스키마→의미 초안) 확인.
