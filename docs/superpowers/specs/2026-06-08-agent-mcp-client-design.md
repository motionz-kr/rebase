# Agent MCP 클라이언트 (외부 도구) — 설계 [sub-project 1: stdio]

> Issue: #36 (Epic) · Milestone #7 (Agent MCP client — external tools)
> Date: 2026-06-08

## 배경 / 목표

앱 내 에이전트(AgentChat)가 **외부 MCP 서버에 연결(아웃바운드)**해 그 도구를 자신의 도구 카탈로그에
병합한다. 엔진은 이미 자신의 DB 도구를 MCP **서버**로 노출하지만(클라이언트가 받는 쪽), 반대 방향인
**MCP 클라이언트**는 없다. 이 슬라이스가 그것을 만든다.

## 범위 결정 (brainstorming 확정)

1. **stdio 전송 우선 수직 슬라이스.** 1차는 로컬 프로세스 stdio MCP 서버만. HTTP/SSE 원격 전송 +
   고급 인증은 2차(별도 spec)로 연기. 대부분의 인기 MCP 서버(npx 기반 filesystem/fetch/git 등)가
   stdio라 실용 가치가 크고 한 계획으로 완결된다.
2. **서버별 신뢰 플래그.** 각 서버에 `trusted` 토글. 신뢰 서버 도구는 자동 실행, 비신뢰(기본값)
   서버 도구는 propose 모델로 사용자 승인 후 실행.
3. **propose 모델 승인.** 비신뢰 서버 도구 호출은 즉시 실행하지 않고 "제안"(서버·도구·인자)으로
   표면화 → 사용자가 실행 버튼 클릭 → 후속 호출로 실제 실행. 기존 `propose_write` 패턴과 동일 →
   스트림 중 동기 대기 불필요, 엔진 단순.

## 재사용 자산 (탐색 확인)

- **JSON-RPC 2.0 프레이밍**: `engine/internal/adapters/mcp/server.go`의 `rpcRequest/rpcResponse/rpcError`
  형태를 클라이언트에서 미러링(서버 타입은 비공개라 클라이언트 패키지에 동형 구조체를 둔다).
- **에이전트 Registry**: `engine/internal/agent/tools.go`의 `Specs()`/`Dispatch()`/(비공개)`add()`.
  외부 도구는 프록시 `Tool`로 등록되어 기존 도구 루프(`service.go Run`)가 투명하게 처리.
- **ports.ToolSpec** `{Name, Description string; Schema map[string]any}` — MCP `tools/list`의
  `inputSchema`와 동형 → 직접 매핑.
- **키체인** `ports.SecretStore` (`Get/Set/Delete`) — 서버 env(민감값) 저장.
- **승인 선례**: `propose_write` 도구 + 렌더러 `RiskConfirmDialog` + autonomy 설정.
- **HTTP/IPC 패턴**: `transport/http` 핸들러(`checkToken`+JSON), `apps/desktop/src/main/index.ts`
  ipcMain.handle → preload → `global.d.ts`.

## 아키텍처 개요

```
[McpServersPanel] (워크스페이스 설정)             [AgentChat]
  · 외부 서버 추가/삭제(name, command, args, env)      │ 질의
  · 서버별 활성/신뢰 토글                               ▼
  · "연결 테스트"(spawn→initialize→tools/list)    /agent/run 핸들러
        │ 저장                                         │ 1) 내장 DB Registry (기존)
        ▼                                              │ 2) 활성 MCP 서버마다 AttachMCPServers:
   mcp_servers 테이블(워크스페이스 스코프)               │    mcpclient.Dial(cmd,args,env)
   env(민감) → 키체인 blob mcp_env_<id>                 │    initialize + tools/list
        │                                              │    → 프록시 Tool 등록(mcp__<server>__<tool>)
        └──────────────────────────────────────────────┤ 3) svc.Run 도구 루프(기존)
                                                        │    Dispatch("mcp__fs__read"):
                          신뢰 서버 → mcpclient.Call 즉시 실행 → 결과
                          비신뢰 서버 → {proposed:true,...} 반환 → 렌더러 제안 → 실행 버튼 → /mcp/servers/call
```

## 컴포넌트 설계

### A. 엔진 — MCP 클라이언트 (`engine/internal/adapters/mcpclient/`, 신규)

```go
type Client struct { /* cmd *exec.Cmd, stdin io.WriteCloser, stdout *bufio.Reader, nextID int */ }

// Dial spawns the server process and performs the initialize handshake.
func Dial(ctx context.Context, command string, args []string, env map[string]string) (*Client, error)

func (c *Client) ListTools(ctx context.Context) ([]ports.ToolSpec, error) // tools/list → ToolSpec[]
func (c *Client) Call(ctx context.Context, name string, args map[string]any) (any, error) // tools/call
func (c *Client) Close() error // stdin 종료 + 프로세스 정리(좀비 방지)
```

- 프레이밍: newline-delimited JSON-RPC 2.0. 요청마다 정수 id 증가, 응답 매칭(순차 요청 가정 — v1은
  도구 호출이 직렬). 타임아웃(ctx) 적용.
- `tools/list` 응답의 각 도구 `{name, description, inputSchema}` → `ports.ToolSpec{Name, Description,
  Schema}`. `tools/call` 응답 `result.content`(MCP 표준: text/json content 배열) → 평문/JSON으로
  정규화해 반환.
- 테스트: 인메모리 fake 서버(`io.Pipe` 양방향)로 initialize/list/call 검증.

### B. 엔진 — 도메인 + 영속화

```go
// engine/internal/domain/mcpserver.go (신규)
type McpServer struct {
    ID, WorkspaceID, Name string
    Command string
    Args    []string // JSON으로 저장
    Enabled bool
    Trusted bool
    CreatedAt, UpdatedAt time.Time
}
```

- 마이그레이션 v10: `mcp_servers` 테이블 (`id, workspace_id, name, command, args TEXT(JSON),
  enabled INTEGER, trusted INTEGER, created_at, updated_at`, FK workspace). repo CRUD
  (`Create/List(workspaceID)/Update/Delete`).
- **env는 DB에 두지 않는다.** 민감값이 SQLite 파일에 남지 않도록 키체인 blob `mcp_env_<serverID>` →
  env map JSON. 서버 저장/삭제 시 함께 set/delete.

### C. 엔진 — 도구 병합 (`engine/internal/agent/`)

```go
// Registry에 외부 도구를 합칠 공개 메서드 (private add 래핑).
func (r *Registry) RegisterExternal(spec ports.ToolSpec, run func(ctx context.Context, args map[string]any) (any, error))

// 활성 서버들을 spawn·tools/list·프록시 등록. 반환 cleanup이 모든 client.Close.
// 실패한 서버는 errors 슬라이스에 모으고 스킵(다른 서버·내장 도구는 정상 동작).
func AttachMCPServers(ctx context.Context, reg *Registry, servers []domain.McpServer,
    env func(serverID string) map[string]string) (cleanup func(), warnings []string)
```

- 프록시 도구 이름: `mcp__<serverName>__<toolName>`(소문자/언더스코어 정규화, LLM 도구명 규칙
  `^[a-zA-Z0-9_-]{1,64}$` 충족). description 앞에 `[외부:<server>]` 출처 표기.
- 신뢰 서버 프록시 `Run`: `client.Call(tool, args)` 즉시 실행.
- 비신뢰 서버 프록시 `Run`: 실행하지 않고 `{"proposed": true, "server": name, "tool": toolName,
  "args": args, "trusted": false}` 반환(propose 모델).

### D. 엔진 — 핸들러/라우트

- `/agent/run` 핸들러: 기존 Registry 구성 직후 워크스페이스 활성 MCP 서버 로드 →
  `AttachMCPServers(...)` → `defer cleanup()`. warnings는 스트림 시작 시 info 청크로 통지(선택).
- `/mcp/servers` GET(목록)/POST(생성·수정)/DELETE. `/mcp/servers/test` POST(spawn→tools/list
  미리보기, 도구 목록 반환). `/mcp/servers/call` POST(비신뢰 제안의 실제 실행: server+tool+args →
  Dial→Call→결과). 모두 `checkToken`.

### E. 렌더러

- `McpServersPanel.tsx`(신규): 서버 목록(이름·command·활성/신뢰 토글), 추가 폼(name, command,
  args 줄단위/스페이스, env key=value), "연결 테스트"(→ `/mcp/servers/test` 도구 목록 미리보기),
  삭제. 기존 `McpConnectPanel`(엔진을 서버로 노출) 옆에 배치(같은 MCP 설정 표면).
- AgentChat: 비신뢰 외부 도구 제안(`proposed:true` + `server/tool`)을 기존 propose UI와 유사하게
  렌더 → "실행" 버튼 → `/mcp/servers/call` 호출 → 결과 표시. 신뢰 서버 결과는 기존 도구 결과처럼 표시.
- 순수 로직(TDD): 서버 폼 검증·args/env 파싱(`mcpServerForm.ts`), 프록시 도구명 표시 파싱
  (`mcp__a__b` → 서버/도구 라벨).

### F. IPC

- preload/main: `mcpServersList()/Save(server)/Delete(id)/Test(server)/Call(serverId,tool,args)` →
  엔진 엔드포인트. `global.d.ts` 타입 추가.

## 도구 호출 흐름 (요약)

- **신뢰 서버**: 에이전트가 `mcp__x__y` 호출 → Dispatch → `client.Call` → 결과 → 루프 계속.
- **비신뢰 서버**: Dispatch → `{proposed:true,...}` → 에이전트가 제안 표면화 → 렌더러 "실행" →
  `/mcp/servers/call` 실제 실행 → 결과 표시. (에이전트 대화는 propose_write와 동일하게 진행.)

## 에러 처리 / 엣지

- **서버 spawn 실패/타임아웃**: 해당 서버 제외(warnings), 에이전트는 내장+나머지 도구로 계속.
- **tools/call 에러**: tool_result에 에러 텍스트(루프 계속, 크래시 없음).
- **도구명 충돌**: `mcp__server__tool` 네임스페이스로 원천 차단.
- **프로세스 정리**: cleanup이 모든 client.Close → stdin 종료 + Wait, 좀비 방지. ctx 취소 시 kill.
- **데이터노출 정책**: 외부 도구 결과는 DB 행이 아니므로 행-수준 정책(metadata withhold) 미적용,
  단 secret 문자열 redaction은 적용(기존 Redact).

## 보안

- 사용자가 명시한 `command`만 실행(임의 코드 실행은 사용자 책임 — UI에 명시 고지).
- `trusted` 기본 false → 새 서버 도구는 기본적으로 승인 필요.
- env 민감값은 키체인에만 저장(메타데이터 DB에 평문 없음).

## 범위 경계

**포함(v1):** A~F (stdio).

**제외(v1, 2차로 연기):**
- HTTP/SSE 원격 전송 + 재연결/네트워크 오류 처리.
- 인증 헤더/OAuth 기반 원격 서버 인증(stdio는 env로 충분).
- MCP `resources`/`prompts` 기능(도구만).
- 서버 프로세스 풀/영속 데몬(v1은 run 단위 spawn).
- 병렬 도구 호출(v1은 직렬 id 매칭).

## 테스트 전략

- **mcpclient(Go)**: fake 서버(io.Pipe) 상대 initialize/list/call/close, 타임아웃, 에러 응답.
- **AttachMCPServers**: 등록·네임스페이싱(`mcp__x__y`)·신뢰/비신뢰 분기·실패 서버 스킵(warnings).
- **repo**: 마이그레이션 v10 + mcp_servers CRUD 왕복 + env 키체인 set/get/delete.
- **렌더러 순수**: 폼 검증·args/env 파싱·프록시 도구명 라벨 파싱.
- **컴포넌트**: 빌드/타입체크.
- **CDP 라이브**: 경량 stdio MCP 서버(인메모리 Node echo 서버 또는 `@modelcontextprotocol/server-everything`)
  를 패널에서 추가→연결 테스트(도구 목록)→신뢰 토글→AgentChat에서 그 도구 호출→결과 확인. 비신뢰
  경로는 제안→실행 버튼→결과 확인.

## 완료 기준 (에픽 #36 매핑, stdio 슬라이스)

- [x] MCP 클라이언트(stdio) — A(mcpclient)
- [x] 서버 레지스트리/설정 UI(워크스페이스별 추가/삭제) — B(persistence) + E(McpServersPanel)
- [x] 외부 도구를 카탈로그에 병합 + 출처표시 — C(AttachMCPServers, `mcp__server__tool`)
- [x] 서버별 활성 + 안전(호출 전 승인) — B(enabled/trusted) + propose 모델
- [x] 외부 서버 인증/시크릿(키체인) — B(env 키체인 blob)
- [ ] HTTP/SSE 전송 — **2차(별도 spec)**
