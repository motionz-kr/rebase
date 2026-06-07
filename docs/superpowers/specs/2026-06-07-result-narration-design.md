# 쿼리 결과 → 업무 문장 변환 (Result Narration) — 설계

> Issue: #104 · Epic #107 · Milestone #8 (DB Tool v1)
> Date: 2026-06-07

## 배경 / 목표

DB 조회 결과는 보통 테이블로 보지만, 실무에서는 그 결과를 **업무 목적별 문장**(Jira 댓글,
Slack 공유, CS 답변, 개발 원인분석, 고객 안내)으로 정리해 공유한다. 이 변환을 매번 손으로
하는 반복을 줄인다 — 쿼리 결과를 목적에 맞는 문장으로 **자동 생성**하고 복사하게 한다.

이 기능은 본질적으로 AI 생성(풍부한 목적별 자연어)이다. 앱의 기존 AI 어시스턴트 설정
(Claude/OpenAI API 키 또는 OAuth)을 그대로 재사용한다.

## 핵심 결정 (brainstorming 확정)

1. **AI 미설정 시 결정적 폴백** — AI 설정 시 풍부한 목적별 문장, 미설정 시 #105의 결정적
   요약(`templateSummary`: 총 N행·상위 항목)을 기본 제공. 둘 다 복사 가능.
2. **노출 위치** = SQL 에디터 결과 + 템플릿 Runner 결과. 공용 `ResultNarrator` 컴포넌트.
3. **엔진 경로** = 신규 도구 없는 일회성 LLM 엔드포인트(`/agent/complete`).

## 아키텍처 개요

```
[ResultNarrator] (QueryEditor 결과 + TemplateRunner 결과에 마운트)
   목적 선택(5) → 생성
        │ AI 설정됨?
        ├─ 예 → buildNarrationMessages(purpose, {sql, columns, rows≤50, rowCount})
        │        → generateNarration IPC → POST /agent/complete (도구 없음)
        │        → provider.Complete() 스트리밍 텍스트
        └─ 아니오 → templateSummary 결정적 요약(일반/Slack/Jira)
        ▼
   출력 영역(스트리밍) + 복사(Markdown / Plain)
```

- 엔진은 도구 없는 `provider.Complete()`만 호출 → 제공된 결과 데이터만 사용(DB 재조회 없음).
- 프롬프트 빌딩·폴백·목적 정의는 **렌더러 순수 함수**(TDD).
- provider 자격(API 키/OAuth, 키체인) + `dataExposure` 정책은 기존 에이전트 경로 재사용.

## 컴포넌트 설계

### A. 엔진 — `POST /agent/complete` (도구 없는 일회성 생성)

`engine/internal/transport/http/agent.go`에 신규 핸들러 추가(기존 `AgentHandler`에 메서드).
- 요청: `{ messages: [{role, text}], provider, apiKey, model, dataExposure }` (profileId 불필요 —
  DB 도구를 안 쓰므로). 단, 토큰 인증은 동일.
- 동작: provider 해석(기존 키/OAuth 로직 재사용) → `provider.Complete(ctx, LLMRequest{Messages,
  Model, Tools: nil}, emit)` 호출 → `emit`을 NDJSON으로 flush(기존 `/agent/run`과 동일한
  `ports.LLMEvent` 라인 포맷). 도구 레지스트리·tool 루프 없음.
- 라우트 등록(main.go): `mux.Handle("/agent/complete", ...)`.
- provider 해석 로직이 `/agent/run` 핸들러에 인라인이면, 공용 헬퍼(`resolveProvider(body) (ports.LLMProvider, error)`)로 추출해 두 핸들러가 공유.
- **테스트**: provider를 가짜(fake)로 주입할 수 있는 형태로 핸들러 단위 테스트(텍스트 emit→NDJSON). 실제 provider 호출은 CDP 라이브로.

### B. 렌더러 — 프롬프트 빌더 + 폴백 (`resultNarration.ts`, 순수·TDD)

```ts
export type NarrationPurpose = 'jira' | 'slack' | 'cs' | 'dev' | 'customer';

export interface NarrationInput {
  sql: string;            // 실행한 SQL (맥락)
  columns: string[];
  rows: unknown[][];      // 전체 결과(빌더가 캡)
  rowCount: number;       // 총 행 수(rows가 캡됐을 수 있음)
}

export interface LLMMessage { role: 'system' | 'user'; text: string; }

// 목적별 system 프롬프트 + 결과 데이터를 담은 user 메시지를 만든다.
export function buildNarrationMessages(p: NarrationPurpose, input: NarrationInput): LLMMessage[];

// AI 미설정 시 결정적 폴백(템플릿 요약 재사용).
export function deterministicNarration(p: NarrationPurpose, input: NarrationInput): string;
```

- **목적 5종 프롬프트**(`PURPOSE_PROMPTS: Record<NarrationPurpose, {label, system}>`):
  - `jira` — 마크다운 섹션(확인 결과 / 특이사항 / 후속 조치) 구조.
  - `slack` — 간결한 단락 + mrkdwn.
  - `cs` — 고객 응대 톤(정중·비기술적), 원인+조치 안내.
  - `dev` — 원인 분석·재현·개선 제안(기술적).
  - `customer` — 고객 안내 문구(완곡·안심).
  각 system 프롬프트는 "제공된 결과 데이터만 사용, 추측 금지, 한국어"를 명시.
- **user 메시지**: `SQL: …\n컬럼: …\n총 N행 (상위 M행 표시):\n<행 데이터>` 형식.
- **행 캡**: 빌더 호출 전 호출측이 `rows.slice(0, 50)` + `rowCount`(원본 길이) 전달. 빌더는
  받은 rows를 그대로 직렬화.
- **deterministicNarration**: `buildSummary`/`formatSummary`(#105) 재사용해 목적→포맷 매핑
  (jira→'jira', slack→'slack', 그 외→'plain').

### C. IPC 배선

- preload: `generateNarration(runId, profileId, messages, options)` → `ipcRenderer.invoke('generate-narration', …)`. (profileId는 향후 확장 위해 전달하되 엔진은 미사용.)
- main: `ipcMain.handle('generate-narration', …)` → POST `/agent/complete` 스트리밍 →
  `webContents.send('agent-stream-chunk', runId, chunk)` (기존 에이전트 스트림 채널·청크 재사용).
- 렌더러는 기존 `onAgentStreamChunk`로 수신(text/done/error). global.d.ts 타입 추가.

### D. 공용 컴포넌트 `ResultNarrator.tsx`

입력: `{ sql, columns, rows, profileId }`. 동작:
- 상단: 목적 선택 칩 5개(Jira/Slack/CS/개발/고객).
- "생성" 버튼 → AI 가용 시 `buildNarrationMessages` → `generateNarration` 스트리밍을 출력
  영역에 누적; 미가용 시 `deterministicNarration` 즉시 표시.
- 출력 영역(`<pre>`/textarea) + 복사 버튼(Markdown 원문 / Plain 텍스트).
- AI 가용성: 마운트 시 `agentKeyStatus`/`agentOAuthStatus`로 판단, 미설정이면 "AI 설정 시 더
  풍부한 문장" 힌트 + 결정적 폴백만.
- 데이터 노출 고지: "결과 데이터가 AI에 전송됩니다" 라벨(AI 사용 시).
- 행 캡 50은 컴포넌트에서 적용해 빌더에 전달.

**마운트**: QueryEditor 결과 영역(내보내기 근처) + TemplateRunner 결과 후속 바. 토글(접기)로
공간 절약. 기존 흐름은 ADDITIVE(깨지 않음).

### E. AI 가용성 + 데이터 노출

- provider/모델 선택은 기존 에이전트 설정(SettingsPopover/AgentChat이 쓰는 값) 재사용 —
  ResultNarrator는 동일 provider/model/dataExposure를 옵션으로 전달.
- 노출: 결과 행을 LLM에 전송. read-only(쓰기·DB 재조회 없음). 사용자에게 명시.

## 범위 경계

**포함(v1):** A~E.

**제외(v1, YAGNI):**
- Jira/Slack 실제 API 전송(복사까지만 — 이슈 비고와 일치).
- 멀티 결과셋 동시 변환, 결과 일부 선택 변환.
- 생성 문장의 대화형 후속 수정(재생성/목적 변경만).
- 사용자 커스텀 목적/톤 정의(5개 프리셋 고정).
- 비-SQL 엔진(Redis/Mongo) 결과 — v1은 SQL 결과 그리드만.

## 테스트 전략

- **순수 로직(Vitest TDD)**: `buildNarrationMessages`(목적별 system 포함·결과 직렬화·캡 반영),
  `deterministicNarration`(폴백 3포맷), 목적 정의 무결성.
- **엔진(Go)**: `/agent/complete` 핸들러를 fake provider로 단위 테스트(messages→Complete 호출,
  텍스트 emit→NDJSON 스트림, tool 미사용 확인). provider 해석 헬퍼 추출 회귀 없음.
- **렌더러 컴포넌트**: 빌드/타입체크(testing-library 없음 — 로직은 순수 테스트로 커버).
- **CDP 라이브**: 키체인 OAuth로 dev-mysql 결과(`erg_*` 임시) → Jira/Slack 목적 생성·스트리밍·
  복사 확인. AI 미설정 경로(폴백) 확인.

## 완료 기준 (이슈 #104 매핑)

- [x] 쿼리 결과 자연어 요약 → B(AI) + 폴백
- [x] Jira 댓글용 문장 → B(`jira` 프롬프트)
- [x] Slack 공유용 → B(`slack`)
- [x] CS 답변용 → B(`cs`)
- [x] 개발자 원인 분석용 → B(`dev`)
- [x] 생성 문장 복사 → D(Markdown/Plain)
- [x] 사용자가 톤(목적) 선택 → D(목적 칩 5개)
