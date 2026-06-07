# 쿼리 결과 → 업무 문장 변환 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 쿼리 결과(컬럼+행)를 목적별(Jira/Slack/CS/개발/고객) 업무 문장으로 AI 생성하고, AI 미설정 시 결정적 요약으로 폴백하며, 복사할 수 있게 한다.

**Architecture:** 엔진에 도구 없는 일회성 LLM 엔드포인트 `POST /agent/complete`(provider.Complete만 호출, DB 도구·재조회 없음)를 추가. 렌더러 순수 함수가 목적별 프롬프트(system+user)와 결정적 폴백을 만들고, 공용 `ResultNarrator` 컴포넌트가 QueryEditor·TemplateRunner 결과에 붙어 스트리밍 생성·복사한다. provider 자격(키/OAuth)·dataExposure는 기존 에이전트 경로를 재사용한다.

**Tech Stack:** Go 1.25(엔진, 표준 net/http), TypeScript/React 19(렌더러, Vitest), Electron IPC.

**Toolchain:** Go는 `/Users/smlee/sdk/go/bin/go`. 렌더러 `pnpm --filter renderer test`. 통합/CDP는 dev-mysql `127.0.0.1:3306` root/`password1!` `devdb` — `erg_*` 임시 테이블만.

**기존 재사용(확인됨):**
- 엔진 `ports.LLMProvider.Complete(ctx, LLMRequest{System,Messages,Tools,Model}, emit func(LLMEvent)) error` (`engine/internal/ports/llm.go`). `LLMEvent{Kind: "text"|"done"|"error", Text, Err}`. system은 `LLMRequest.System`(별도), `LLMMessage.Role`은 user/assistant/tool.
- 에이전트 핸들러 provider 해석 스위치 `agent.go:218-259`(anthropic/anthropic-oauth/openai/openai-oauth/cli/codex/stub). `StubProvider`는 일반 user 메시지에 text+done emit.
- 라우트 등록 `main.go:296-300`(`agentHandler` 이미 생성). 에이전트 IPC: preload `agentRun`/`agentKeyStatus`/`agentOAuthStatus`/`onAgentStreamChunk`(채널 `agent-stream-chunk`), main `agent-run`(`apps/desktop/src/main/index.ts:628`).
- 에이전트 설정: localStorage `rebase.agent.settings` → `{provider, model, autonomy, dataExposure}`(`AgentChat.tsx`). 기본 `anthropic-oauth`/`claude-sonnet-4-6`/`metadata`.
- #105 결정적 요약 `apps/renderer/src/lib/templateSummary.ts`: `buildSummary(title, columns, rows)` + `formatSummary(s, 'plain'|'slack'|'jira')`.
- 결과셋: QueryEditor `activeTab.columns/rows`(+`activeTab.query` SQL), TemplateRunner `result.{columns,rows}`(+`rendered.sql`).

---

## File Structure

**엔진(수정):**
- `engine/internal/transport/http/agent.go` — provider 해석을 `buildProvider` 헬퍼로 추출, `Run()`이 이를 사용, 신규 `Complete()` 핸들러
- `engine/internal/transport/http/agent_complete_test.go` — `/agent/complete` 핸들러 테스트(stub)
- `engine/cmd/app-engine/main.go` — `/agent/complete` 라우트

**렌더러(신규):**
- `apps/renderer/src/lib/agentSettings.ts` — `loadAgentSettings()` + 타입(`rebase.agent.settings` 재사용)
- `apps/renderer/src/lib/resultNarration.ts` + `.test.ts` — 목적 프롬프트·`buildNarrationPrompt`·`deterministicNarration`(순수)
- `apps/renderer/src/components/ResultNarrator.tsx` — 공용 패널

**렌더러(수정):**
- `apps/desktop/src/preload/index.ts` · `apps/desktop/src/main/index.ts` · `apps/renderer/src/global.d.ts` — `generateNarration` IPC
- `apps/renderer/src/components/QueryEditor.tsx` · `apps/renderer/src/components/TemplateRunner.tsx` — ResultNarrator 마운트
- `apps/renderer/src/App.css` — 스타일

---

## Task 1: 엔진 — `/agent/complete` (도구 없는 일회성 생성)

**Files:**
- Modify: `engine/internal/transport/http/agent.go`
- Create: `engine/internal/transport/http/agent_complete_test.go`
- Modify: `engine/cmd/app-engine/main.go`

- [ ] **Step 1: 실패 테스트** — `agent_complete_test.go`:
```go
package http

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smlee/database-local-engine/engine/internal/application"
)

func TestAgentComplete_StubStreamsTextNoTools(t *testing.T) {
	// service can be nil-ish: the "stub" provider path never touches it.
	h := NewAgentHandler("tok", &application.ConnectionService{})
	body, _ := json.Marshal(map[string]any{
		"provider": "stub",
		"system":   "You write summaries.",
		"messages": []map[string]string{{"role": "user", "text": "hello there"}},
	})
	req := httptest.NewRequest(http.MethodPost, "/agent/complete", bytes.NewReader(body))
	req.Header.Set("X-App-Engine-Token", "tok")
	w := httptest.NewRecorder()
	h.Complete().ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status: %d body=%s", w.Code, w.Body.String())
	}
	out := w.Body.String()
	if !strings.Contains(out, `"kind":"text"`) || !strings.Contains(out, `"kind":"done"`) {
		t.Fatalf("expected text+done NDJSON, got: %s", out)
	}
	if strings.Contains(out, `"kind":"tool_call"`) {
		t.Fatalf("complete must not run tools: %s", out)
	}
}

func TestAgentComplete_RejectsBadMethodAndAuth(t *testing.T) {
	h := NewAgentHandler("tok", &application.ConnectionService{})
	// missing token
	req := httptest.NewRequest(http.MethodPost, "/agent/complete", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	h.Complete().ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", w.Code)
	}
}
```

- [ ] **Step 2: 실패 확인** — Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/transport/http/ -run TestAgentComplete -v` → FAIL (`Complete` 미정의).

- [ ] **Step 3a: provider 해석 추출** — `agent.go`에서 `Run()` 안의 provider 결정 블록(현재 line 218-259)을 헬퍼로 추출. `Run()` 위에 추가:
```go
// providerParams carries the fields needed to construct an LLM provider.
type providerParams struct {
	ProfileID string
	Provider  string
	APIKey    string
	Model     string
}

// buildProvider resolves an LLMProvider from request params, reusing the same
// credential rules as the agent (explicit key → keychain; OAuth via keychain).
// The returned cleanup func removes any temp MCP config (cli provider); callers
// must defer it. Shared by Run() and Complete().
func (h *AgentHandler) buildProvider(ctx context.Context, p providerParams) (ports.LLMProvider, func(), error) {
	cleanup := func() {}
	apiKey := p.APIKey
	if apiKey == "" && (p.Provider == "anthropic" || p.Provider == "openai") {
		if k, kerr := h.service.GetAgentKey(ctx, p.Provider); kerr == nil {
			apiKey = k
		}
	}
	switch p.Provider {
	case "anthropic":
		return llm.NewAnthropicProvider(apiKey, p.Model, ""), cleanup, nil
	case "anthropic-oauth":
		return llm.NewAnthropicOAuthProvider(oauthTokenStore{service: h.service, provider: "anthropic"}, p.Model, ""), cleanup, nil
	case "openai-oauth":
		return llm.NewCodexOAuthProvider(oauthTokenStore{service: h.service, provider: "openai"}, p.Model), cleanup, nil
	case "openai":
		return llm.NewOpenAIProvider(apiKey, p.Model, ""), cleanup, nil
	case "cli":
		exe, err := os.Executable()
		if err != nil {
			return nil, cleanup, err
		}
		tmp, err := os.CreateTemp("", "rebase-mcp-*.json")
		if err != nil {
			return nil, cleanup, err
		}
		_, _ = tmp.WriteString(buildMCPConfig(exe, p.ProfileID))
		_ = tmp.Close()
		name := tmp.Name()
		return llm.NewCliProvider(name, "default", os.Environ()), func() { os.Remove(name) }, nil
	case "codex":
		exe, err := os.Executable()
		if err != nil {
			return nil, cleanup, err
		}
		return llm.NewCodexProvider(exe, p.ProfileID, p.Model, os.Environ()), cleanup, nil
	default:
		return llm.NewStubProvider(), cleanup, nil
	}
}
```
Then in `Run()`, REPLACE the inline provider switch (line ~218-259) with:
```go
		provider, cleanup, perr := h.buildProvider(r.Context(), providerParams{
			ProfileID: body.ProfileID, Provider: body.Provider, APIKey: body.APIKey, Model: body.Model,
		})
		if perr != nil {
			http.Error(w, perr.Error(), http.StatusInternalServerError)
			return
		}
		defer cleanup()
```
(Keep the rest of `Run()` — registry, svc, streaming — unchanged.)

- [ ] **Step 3b: Complete 핸들러** — `agent.go`에 추가:
```go
// Complete streams a single tool-free LLM completion as NDJSON (one
// ports.LLMEvent per line). Unlike Run(), it attaches NO DB tools, so the model
// answers purely from the provided messages (used for result→work-sentence
// narration). Body: {profileId?, messages, system, provider, apiKey, model}.
func (h *AgentHandler) Complete() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			ProfileID string             `json:"profileId"`
			Messages  []ports.LLMMessage `json:"messages"`
			System    string             `json:"system"`
			Provider  string             `json:"provider"`
			APIKey    string             `json:"apiKey"`
			Model     string             `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request body", http.StatusBadRequest)
			return
		}
		if len(body.Messages) == 0 {
			http.Error(w, "a non-empty messages array is required", http.StatusBadRequest)
			return
		}
		provider, cleanup, perr := h.buildProvider(r.Context(), providerParams{
			ProfileID: body.ProfileID, Provider: body.Provider, APIKey: body.APIKey, Model: body.Model,
		})
		if perr != nil {
			http.Error(w, perr.Error(), http.StatusInternalServerError)
			return
		}
		defer cleanup()

		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("Cache-Control", "no-cache")
		flusher, _ := w.(http.Flusher)
		enc := json.NewEncoder(w)
		emit := func(e ports.LLMEvent) {
			_ = enc.Encode(e)
			if flusher != nil {
				flusher.Flush()
			}
		}
		req := ports.LLMRequest{System: body.System, Messages: body.Messages, Tools: nil, Model: body.Model}
		if err := provider.Complete(r.Context(), req, emit); err != nil {
			emit(ports.LLMEvent{Kind: ports.EventError, Err: err.Error()})
		}
	})
}
```

- [ ] **Step 4: 라우트** — `main.go`의 `mux.Handle("/agent/run", agentHandler.Run())` 다음 줄에 추가:
```go
	mux.Handle("/agent/complete", agentHandler.Complete())
```

- [ ] **Step 5: 통과 + 회귀 확인** — Run: `/Users/smlee/sdk/go/bin/go test ./engine/... && /Users/smlee/sdk/go/bin/go build ./engine/...` → PASS(신규 Complete 테스트 + 기존 agent/http 테스트 모두 그린; `Run()` 동작 보존).

- [ ] **Step 6: 커밋**
```bash
cd /Users/smlee/projects/product/database
git add engine/internal/transport/http/agent.go engine/internal/transport/http/agent_complete_test.go engine/cmd/app-engine/main.go
git commit -m "feat(engine): 도구 없는 /agent/complete 일회성 LLM 생성 (#104)"
```

---

## Task 2: 렌더러 — 에이전트 설정 로더 (`agentSettings.ts`)

**Files:**
- Create: `apps/renderer/src/lib/agentSettings.ts`
- Test: `apps/renderer/src/lib/agentSettings.test.ts`

- [ ] **Step 1: 실패 테스트** — `agentSettings.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { loadAgentSettings, AGENT_SETTINGS_KEY } from './agentSettings';

describe('agentSettings', () => {
  beforeEach(() => localStorage.clear());
  it('returns defaults when nothing stored', () => {
    const s = loadAgentSettings();
    expect(s.provider).toBe('anthropic-oauth');
    expect(s.dataExposure).toBe('metadata');
  });
  it('reads stored settings', () => {
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify({ provider: 'openai', model: 'gpt-x', dataExposure: 'unrestricted' }));
    const s = loadAgentSettings();
    expect(s.provider).toBe('openai');
    expect(s.model).toBe('gpt-x');
  });
  it('survives malformed JSON', () => {
    localStorage.setItem(AGENT_SETTINGS_KEY, '{bad');
    expect(loadAgentSettings().provider).toBe('anthropic-oauth');
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm --filter renderer test agentSettings` → FAIL.

- [ ] **Step 3: 구현** — `agentSettings.ts`:
```ts
// Shared read of the agent provider settings (mirrors the key written by
// AgentChat) so other AI features (e.g. result narration) use the same provider.
export const AGENT_SETTINGS_KEY = 'rebase.agent.settings';

export type AgentProvider = 'anthropic' | 'anthropic-oauth' | 'openai' | 'openai-oauth';

export interface AgentSettings {
  provider: AgentProvider;
  model: string;
  dataExposure: 'metadata' | 'on_request' | 'unrestricted';
}

const DEFAULTS: AgentSettings = {
  provider: 'anthropic-oauth',
  model: 'claude-sonnet-4-6',
  dataExposure: 'metadata',
};

export function loadAgentSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(AGENT_SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      provider: parsed.provider ?? DEFAULTS.provider,
      model: parsed.model ?? DEFAULTS.model,
      dataExposure: parsed.dataExposure ?? DEFAULTS.dataExposure,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function isOAuthProvider(p: AgentProvider): boolean {
  return p === 'anthropic-oauth' || p === 'openai-oauth';
}
```

- [ ] **Step 4: 통과 + 커밋** — Run: `pnpm --filter renderer test agentSettings` → PASS.
```bash
git add apps/renderer/src/lib/agentSettings.ts apps/renderer/src/lib/agentSettings.test.ts
git commit -m "feat(renderer): 공용 에이전트 설정 로더 (#104)"
```

---

## Task 3: 렌더러 — 목적 프롬프트 + 결정적 폴백 (`resultNarration.ts`, TDD)

**Files:**
- Create: `apps/renderer/src/lib/resultNarration.ts`
- Test: `apps/renderer/src/lib/resultNarration.test.ts`

- [ ] **Step 1: 실패 테스트** — `resultNarration.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { NARRATION_PURPOSES, buildNarrationPrompt, deterministicNarration } from './resultNarration';

const input = {
  sql: 'SELECT phone, COUNT(*) c FROM User GROUP BY phone',
  columns: ['phone', 'c'],
  rows: [['010-1', 3], ['010-2', 2]],
  rowCount: 2,
};

describe('resultNarration', () => {
  it('exposes 5 purposes with labels', () => {
    const ids = NARRATION_PURPOSES.map((p) => p.id);
    expect(ids).toEqual(['jira', 'slack', 'cs', 'dev', 'customer']);
    for (const p of NARRATION_PURPOSES) expect(p.label.length).toBeGreaterThan(0);
  });

  it('builds a system+user prompt embedding sql, columns, rows and total count', () => {
    const { system, user } = buildNarrationPrompt('jira', input);
    expect(system.toLowerCase()).toContain('jira');
    expect(system).toMatch(/제공된|결과|데이터/); // grounding instruction
    expect(user).toContain('SELECT phone');
    expect(user).toContain('phone');
    expect(user).toContain('010-1');
    expect(user).toContain('2'); // total row count
  });

  it('each purpose yields a distinct system prompt', () => {
    const systems = NARRATION_PURPOSES.map((p) => buildNarrationPrompt(p.id, input).system);
    expect(new Set(systems).size).toBe(systems.length);
  });

  it('deterministic fallback maps purpose to a format and includes the row count', () => {
    expect(deterministicNarration('jira', input)).toContain('#'); // jira list marker
    expect(deterministicNarration('slack', input)).toContain('*'); // slack bold
    expect(deterministicNarration('cs', input)).toContain('2');     // plain, row count
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm --filter renderer test resultNarration` → FAIL.

- [ ] **Step 3: 구현** — `resultNarration.ts`:
```ts
import { buildSummary, formatSummary, type SummaryFormat } from './templateSummary';

export type NarrationPurpose = 'jira' | 'slack' | 'cs' | 'dev' | 'customer';

export interface NarrationInput {
  sql: string;
  columns: string[];
  rows: unknown[][];   // already capped by the caller
  rowCount: number;    // total rows (may exceed rows.length)
}

export interface NarrationPrompt {
  system: string;
  user: string;
}

const GROUND = '제공된 쿼리 결과 데이터만 근거로 사용하고, 데이터에 없는 내용은 추측하지 마세요. 한국어로 작성하세요.';

export const NARRATION_PURPOSES: { id: NarrationPurpose; label: string; system: string }[] = [
  {
    id: 'jira', label: 'Jira 댓글',
    system: `당신은 DB 조회 결과를 Jira 댓글로 정리하는 엔지니어입니다. 마크다운으로 "## 확인 결과", "## 특이사항", "## 후속 조치" 세 섹션을 작성합니다. 수치는 목록으로 정리합니다. ${GROUND}`,
  },
  {
    id: 'slack', label: 'Slack 공유',
    system: `당신은 DB 조회 결과를 Slack에 공유하는 동료입니다. 2~4문장의 간결한 단락으로 핵심 수치와 특이사항을 전달합니다. 과한 마크다운은 피합니다. ${GROUND}`,
  },
  {
    id: 'cs', label: 'CS 답변',
    system: `당신은 고객 문의에 답하는 CS 담당자입니다. 비기술적이고 정중한 톤으로, 확인된 사실과 진행 예정 조치를 안내합니다. 내부 용어/컬럼명은 노출하지 않습니다. ${GROUND}`,
  },
  {
    id: 'dev', label: '개발 원인 분석',
    system: `당신은 데이터 이상을 분석하는 개발자입니다. 관찰된 사실, 추정 원인, 재현/확인 방법, 개선 제안을 기술적으로 정리합니다. ${GROUND}`,
  },
  {
    id: 'customer', label: '고객 안내',
    system: `당신은 고객에게 상황을 안내하는 담당자입니다. 완곡하고 안심을 주는 톤으로, 현재 확인된 상황과 처리 방향을 쉽게 설명합니다. 민감한 내부 데이터는 노출하지 않습니다. ${GROUND}`,
  },
];

function serializeRows(columns: string[], rows: unknown[][]): string {
  const head = columns.join(' | ');
  const body = rows
    .map((r) => columns.map((_, i) => (r[i] == null ? 'NULL' : String(r[i]))).join(' | '))
    .join('\n');
  return `${head}\n${body}`;
}

export function buildNarrationPrompt(purpose: NarrationPurpose, input: NarrationInput): NarrationPrompt {
  const def = NARRATION_PURPOSES.find((p) => p.id === purpose) ?? NARRATION_PURPOSES[0];
  const shown = input.rows.length;
  const user =
    `실행한 SQL:\n${input.sql}\n\n` +
    `컬럼: ${input.columns.join(', ')}\n` +
    `총 ${input.rowCount}행 (상위 ${shown}행 표시):\n` +
    serializeRows(input.columns, input.rows) +
    `\n\n위 결과를 바탕으로 ${def.label} 문장을 작성하세요.`;
  return { system: def.system, user };
}

export function deterministicNarration(purpose: NarrationPurpose, input: NarrationInput): string {
  const fmt: SummaryFormat = purpose === 'jira' ? 'jira' : purpose === 'slack' ? 'slack' : 'plain';
  const s = buildSummary('쿼리 결과 요약', input.columns, input.rows);
  return formatSummary(s, fmt);
}
```

- [ ] **Step 4: 통과 + 커밋** — Run: `pnpm --filter renderer test resultNarration && pnpm --filter renderer build`.
```bash
git add apps/renderer/src/lib/resultNarration.ts apps/renderer/src/lib/resultNarration.test.ts
git commit -m "feat(renderer): 목적별 문장 프롬프트 + 결정적 폴백 (#104)"
```

---

## Task 4: 렌더러 — generateNarration IPC

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/renderer/src/global.d.ts`

- [ ] **Step 1: preload** — `apps/desktop/src/preload/index.ts`의 `agentRun`(line 45-50) 근처에 추가:
```ts
  generateNarration: (
    runId: string,
    profileId: string,
    system: string,
    messages: Array<{ role: string; text: string }>,
    options?: { provider?: string; apiKey?: string; model?: string }
  ) => ipcRenderer.invoke('generate-narration', runId, profileId, system, messages, options),
```
(스트리밍 수신은 기존 `onAgentStreamChunk` 재사용 — 별도 채널 불필요.)

- [ ] **Step 2: main** — `apps/desktop/src/main/index.ts`의 `agent-run` 핸들러(line 628 부근)를 참고해 동일 스트리밍 패턴으로 추가. `/agent/run` 대신 `/agent/complete`로 POST하고 body에 `system`을 포함, 청크는 동일하게 `agent-stream-chunk`로 전달:
```ts
  ipcMain.handle('generate-narration', async (event, runId, profileId, system, messages, options) => {
    return streamAgentRequest(event, runId, '/agent/complete', {
      profileId, system, messages,
      provider: options?.provider, apiKey: options?.apiKey, model: options?.model,
    });
  });
```
> 주: `agent-run` 핸들러가 인라인 fetch+stream 로직을 쓰면, 그 로직을 `streamAgentRequest(event, runId, path, body)` 헬퍼로 추출해 두 핸들러가 공유한다(경로·body만 다름). 추출이 위험하면 `agent-run` 핸들러 본문을 복제해 `/agent/complete`+`system`만 바꿔도 됨 — 단, 청크를 `agent-stream-chunk`(runId 포함)로 보내는 부분은 동일하게 유지.

- [ ] **Step 3: 타입** — `apps/renderer/src/global.d.ts` ElectronAPI에 추가:
```ts
  generateNarration: (
    runId: string,
    profileId: string,
    system: string,
    messages: Array<{ role: string; text: string }>,
    options?: { provider?: string; apiKey?: string; model?: string }
  ) => Promise<{ success: boolean; error?: string }>;
```

- [ ] **Step 4: 빌드 + 커밋** — Run: `pnpm --filter desktop build && pnpm --filter renderer build`.
```bash
git add apps/desktop/src/preload/index.ts apps/desktop/src/main/index.ts apps/renderer/src/global.d.ts
git commit -m "feat(renderer): generate-narration IPC (#104)"
```

---

## Task 5: 렌더러 — ResultNarrator 컴포넌트

**Files:**
- Create: `apps/renderer/src/components/ResultNarrator.tsx`

- [ ] **Step 1: 구현** — AI 가용 시 스트리밍 생성, 미가용 시 결정적 폴백. 빌드/타입체크로 검증(테스트 프레임워크 없음). 스트리밍 청크는 `onAgentStreamChunk`(kind text/done/error) 사용:
```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  NARRATION_PURPOSES, buildNarrationPrompt, deterministicNarration, type NarrationPurpose,
} from '../lib/resultNarration';
import { loadAgentSettings, isOAuthProvider } from '../lib/agentSettings';

const ROW_CAP = 50;

interface Props {
  profileId: string;
  sql: string;
  columns: string[];
  rows: unknown[][];
}

export function ResultNarrator({ profileId, sql, columns, rows }: Props) {
  const [purpose, setPurpose] = useState<NarrationPurpose>('jira');
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const [aiReady, setAiReady] = useState(false);
  const offRef = useRef<(() => void) | null>(null);
  useEffect(() => () => offRef.current?.(), []);

  const settings = useMemo(() => loadAgentSettings(), []);
  // Privacy gate: sending result rows to the LLM contradicts the default
  // dataExposure='metadata'. Require explicit per-use consent unless the user
  // already chose 'unrestricted'. The deterministic fallback never sends data.
  const [consent, setConsent] = useState(false);
  const needsConsent = aiReady && settings.dataExposure !== 'unrestricted';
  useEffect(() => {
    let alive = true;
    (async () => {
      const p = settings.provider;
      const res = isOAuthProvider(p)
        ? await window.electronAPI.agentOAuthStatus(p === 'openai-oauth' ? 'openai' : 'anthropic')
        : await window.electronAPI.agentKeyStatus(p);
      if (!alive) return;
      const ok = !!(res?.success && (res.data?.present || res.data?.loggedIn));
      setAiReady(ok);
    })();
    return () => { alive = false; };
  }, [settings.provider]);

  const input = useMemo(
    () => ({ sql, columns, rows: rows.slice(0, ROW_CAP), rowCount: rows.length }),
    [sql, columns, rows],
  );

  function generate() {
    if (!aiReady) {
      setOutput(deterministicNarration(purpose, input));
      return;
    }
    if (needsConsent && !consent) return; // privacy gate
    setRunning(true);
    setOutput('');
    const runId = `narr-${Date.now()}`;
    const off = window.electronAPI.onAgentStreamChunk((id, chunk) => {
      if (id !== runId) return;
      if (chunk.kind === 'text') setOutput((o) => o + (chunk.text ?? ''));
      else if (chunk.kind === 'error') { setOutput((o) => o + `\n[오류] ${chunk.err ?? ''}`); setRunning(false); off(); }
      else if (chunk.kind === 'done') { setRunning(false); off(); }
    });
    offRef.current = off;
    const { system, user } = buildNarrationPrompt(purpose, input);
    window.electronAPI
      .generateNarration(runId, profileId, system, [{ role: 'user', text: user }], { provider: settings.provider, model: settings.model })
      .then((res) => { if (!res.success) { setOutput(`[오류] ${res.error ?? '생성 실패'}`); setRunning(false); off(); } });
  }

  const copy = () => navigator.clipboard?.writeText(output);
  const copyPlain = () => navigator.clipboard?.writeText(output.replace(/[#*_`>-]/g, '').replace(/\n{2,}/g, '\n').trim());

  return (
    <div className="narrator">
      <div className="narrator-head">
        <div className="narrator-purposes">
          {NARRATION_PURPOSES.map((p) => (
            <button key={p.id} className={`btn btn-sm ${purpose === p.id ? 'btn-primary' : ''}`} onClick={() => setPurpose(p.id)}>
              {p.label}
            </button>
          ))}
        </div>
        <button
          className="btn btn-sm btn-primary"
          disabled={running || rows.length === 0 || (needsConsent && !consent)}
          onClick={generate}
        >
          {running ? '생성 중…' : '문장 생성'}
        </button>
      </div>
      {!aiReady && <p className="narrator-hint">AI 미설정 — 기본 요약을 생성합니다. (어시스턴트에서 AI를 설정하면 더 풍부한 문장)</p>}
      {needsConsent && (
        <label className="narrator-consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          결과 데이터(상위 {ROW_CAP}행)를 AI에 전송하여 문장을 생성하는 데 동의합니다.
        </label>
      )}
      {aiReady && !needsConsent && <p className="narrator-hint">결과 데이터가 AI에 전송됩니다 (상위 {ROW_CAP}행).</p>}
      {output && (
        <>
          <pre className="narrator-output">{output}</pre>
          <div className="narrator-actions">
            <button className="btn btn-sm" onClick={copy}>Markdown 복사</button>
            <button className="btn btn-sm" onClick={copyPlain}>Plain 복사</button>
          </div>
        </>
      )}
    </div>
  );
}
```
> `agentKeyStatus`/`agentOAuthStatus`의 실제 응답 형태(`{success, data:{present}}` / `{success, data:{loggedIn}}`)는 preload/global.d.ts에서 확인해 `res.data?.present`/`res.data?.loggedIn` 접근을 맞춘다(다르면 최소 수정).

- [ ] **Step 2: 빌드 확인** — Run: `pnpm --filter renderer build`.

- [ ] **Step 3: 커밋**
```bash
git add apps/renderer/src/components/ResultNarrator.tsx
git commit -m "feat(renderer): ResultNarrator 결과→업무 문장 패널 (#104)"
```

---

## Task 6: 렌더러 — QueryEditor·TemplateRunner 마운트 + CSS

**Files:**
- Modify: `apps/renderer/src/components/QueryEditor.tsx`
- Modify: `apps/renderer/src/components/TemplateRunner.tsx`
- Modify: `apps/renderer/src/App.css`

- [ ] **Step 1: QueryEditor 마운트** — 결과 그리드가 렌더되는 영역(activeTab.columns/rows가 있는 곳)에 접이식 ResultNarrator를 추가. `import { ResultNarrator } from './ResultNarrator';` 후, ResultGrid 근처(결과가 있을 때)에:
```tsx
{activeTab.columns.length > 0 && (
  <details className="narrator-wrap">
    <summary>업무 문장 생성</summary>
    <ResultNarrator profileId={profileId} sql={activeTab.query} columns={activeTab.columns} rows={activeTab.rows} />
  </details>
)}
```
> `profileId`는 QueryEditor가 이미 받는 prop을 사용. `activeTab.query`는 실행된 SQL. 정확한 변수명은 파일을 읽어 맞춘다(멀티 결과셋이면 활성 결과의 columns/rows/쿼리 사용).

- [ ] **Step 2: TemplateRunner 마운트** — `result`가 있을 때 후속 바 아래에 추가:
```tsx
{result && (
  <details className="narrator-wrap">
    <summary>업무 문장 생성</summary>
    <ResultNarrator profileId={profileId} sql={rendered.sql} columns={result.columns} rows={result.rows} />
  </details>
)}
```
`import { ResultNarrator } from './ResultNarrator';` 추가.

- [ ] **Step 3: CSS** — `App.css` 끝에:
```css
.narrator-wrap { margin-top: 10px; }
.narrator-wrap > summary { cursor: pointer; font-size: 12px; color: var(--text-2); padding: 4px 0; }
.narrator { display: flex; flex-direction: column; gap: 8px; padding: 8px 0; }
.narrator-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.narrator-purposes { display: flex; gap: 4px; flex-wrap: wrap; }
.narrator-hint { font-size: 11px; color: var(--text-3); margin: 0; }
.narrator-consent { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
.narrator-output { background: var(--bg-input); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 10px; font-size: 12px; white-space: pre-wrap; word-break: break-word;
  max-height: 320px; overflow: auto; }
.narrator-actions { display: flex; gap: 8px; }
```

- [ ] **Step 4: 빌드 + 테스트 확인** — Run: `pnpm --filter renderer test && pnpm --filter renderer build && pnpm --filter desktop build` → 전부 PASS.

- [ ] **Step 5: 커밋**
```bash
git add apps/renderer/src/components/QueryEditor.tsx apps/renderer/src/components/TemplateRunner.tsx apps/renderer/src/App.css
git commit -m "feat(renderer): ResultNarrator를 에디터·템플릿 결과에 마운트 + CSS (#104)"
```

---

## Task 7: 검증 — 전체 빌드/테스트 + CDP 라이브

**Files:** (없음)

- [ ] **Step 1: 엔진+렌더러 전체** — Run: `/Users/smlee/sdk/go/bin/go test ./engine/... && /Users/smlee/sdk/go/bin/go build ./engine/... && pnpm --filter renderer test && pnpm --filter renderer build && pnpm --filter desktop build` → 전부 PASS.

- [ ] **Step 2: CDP 라이브** — 앱 빌드 후 Playwright/CDP로 dev-mysql(`erg_*` 임시 테이블) 검증:
  1. 연결 → `SELECT phone, COUNT(*) ... GROUP BY` 실행 → 결과 그리드.
  2. "업무 문장 생성" 펼치기 → 목적 Jira 선택 → "문장 생성".
     - AI 설정(키체인 OAuth)되어 있으면 스트리밍 텍스트가 누적되는지.
     - AI 미설정 시 결정적 요약이 즉시 표시되는지(설정 토글로 양쪽 확인).
  3. Slack/CS 목적 전환 후 재생성 확인.
  4. Markdown/Plain 복사(클립보드) 확인.
  스크린샷 기록.

- [ ] **Step 3: 정리** — `erg_*` 임시 테이블 drop. 변경 있으면 커밋.

---

## Self-Review

**1. Spec coverage:**
- A 엔진 /agent/complete → Task 1
- B 프롬프트+폴백 → Task 3 (+설정 Task 2)
- C IPC → Task 4
- D ResultNarrator + 마운트 → Task 5, 6
- E AI 가용성+노출 → Task 5(aiReady 체크 + **프라이버시 동의 게이트**: dataExposure≠unrestricted면 행 전송 전 명시적 동의 필수)
- 완료기준 7개(요약/Jira/Slack/CS/dev/복사/톤선택) 모두 매핑.

**2. Placeholder scan:** Task 4 main IPC는 `streamAgentRequest` 추출 또는 복제로 안내(기존 `agent-run` 패턴 명확) — 대형 인라인 로직이라 패턴 참조가 적절. Task 5/6의 정확한 변수명(QueryEditor profileId/activeTab)·status 응답 형태는 "파일 읽어 맞춘다"로 명시 — 실제 시그니처 의존이라 적절.

**3. Type consistency:** `NarrationPurpose`/`NarrationInput`/`NarrationPrompt`(resultNarration.ts), `AgentSettings`/`loadAgentSettings`(agentSettings.ts), 엔진 `LLMRequest{System,Messages,Tools,Model}`·`LLMEvent{Kind,Text,Err}` ↔ 핸들러·청크 일치. `buildNarrationPrompt`(Task 3) → `generateNarration(runId, profileId, system, messages, options)`(Task 4) → ResultNarrator 호출(Task 5) 시그니처 일치. 청크 필드 `chunk.kind`/`chunk.text`/`chunk.err`는 엔진 `LLMEvent` JSON(kind/text/err)과 일치.
