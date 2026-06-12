# MCP HTTP 전송 (sub-project 2a) — 설계

> Issue: #36 (Epic) · Milestone #7 (Agent MCP client) · sub-project 2a
> Date: 2026-06-09

## 배경 / 목표

sub-project 1에서 에이전트가 **stdio** MCP 서버에 연결하는 기능을 출시했다(v0.21.0). 이번 2a는
**원격 MCP 서버(Streamable HTTP 전송)**에 연결하는 기능을 추가한다. 인증은 정적 헤더/베어러 토큰
(키체인)으로 한다. OAuth 2.1은 sub-project 2b로 연기한다.

## 범위 결정 (brainstorming 확정)

1. **전송 = Streamable HTTP만** (2025-03 현행 MCP 스펙: 단일 URL에 JSON-RPC를 POST, 응답을
   `application/json` 또는 `text/event-stream`(SSE)로 수신, 세션은 `Mcp-Session-Id` 헤더).
   레거시 HTTP+SSE(2024-11) 전송은 제외.
2. **인증 = 정적 헤더/베어러(키체인)**. 사용자가 `Authorization: Bearer <token>` 등 헤더를 입력 →
   키체인 blob `mcp_headers_<id>`에 저장 → 매 POST에 첨부. OAuth 2.1 플로우는 2b.
3. **분해**: 2a(HTTP+정적 토큰) 먼저, 2b(OAuth) 다음.

## 아키텍처: 전송 추상화

현재 `mcpclient.Client`는 stdio 전용(`w io.Writer`/`r *bufio.Reader`/`cmd` + 파이프 JSON-RPC). HTTP를
깔끔히 더하기 위해 프로토콜 로직(initialize/tools.list/tools.call)은 공유하고 **전송만 교체**한다.

```go
// 신규 내부 인터페이스 (engine/internal/adapters/mcpclient)
type transport interface {
    request(ctx context.Context, method string, params any) (json.RawMessage, error) // id 매칭 응답
    notify(ctx context.Context, method string, params any) error
    Close() error
}
```

- `stdioTransport`: 현재 `Client`의 파이프 로직(mutex + write line + read until matching id)을 이전.
- `httpTransport`: Streamable HTTP. 단일 URL에 JSON-RPC POST.
  - 요청 헤더: `Content-Type: application/json`, `Accept: application/json, text/event-stream`,
    사용자 헤더(인증), 그리고 세션이 있으면 `Mcp-Session-Id`.
  - **POST 하나당 응답 하나** — stdio처럼 여러 메시지가 섞여 오지 않으므로 stdio의 mutex+id-매칭
    루프를 복사하지 말 것. id 카운터는 요청 본문 생성에만 쓰고, 응답은 그 POST의 본문에서 바로 읽는다.
  - 응답 `Content-Type`이 `application/json` → 단일 JSON-RPC 응답 본문 파싱.
  - `text/event-stream` → 최소 SSE 파서로 읽는다: 빈 줄로 구분된 이벤트 블록에서 `data:` 줄을
    `\n`으로 이어 붙여 JSON으로 파싱하고, **`id`가 있는(= 응답) 첫 메시지**를 만나면 그 값을 반환하고
    body를 닫는다(`id` 없는 알림/`event:` 류 줄은 건너뜀). 멀티라인 `data:` 처리, 매칭 id 없이 스트림이
    끝나면 에러.
  - `initialize` 응답 헤더의 `Mcp-Session-Id`를 저장해 이후 요청에 첨부(없으면 생략).
  - `notify`는 본문 POST(2xx/202 기대, 응답 본문 무시).
  - **타임아웃**: 전송 자체는 인위적 캡을 두지 않고 호출자가 넘긴 `ctx`만 따른다(아래 §C 참고).

`Client`는 `transport`를 들고 protocol 메서드(initialize/ListTools/Call)를 그 위에 둔다(메서드들이
`c.t.request(...)`를 호출하도록 이전). 생성자:
- `DialStdio(ctx, command, args, env)` — 기존 `Dial`을 개명·이전(내부적으로 stdioTransport 생성 +
  initialize). **하위호환**: 기존 호출부(`mcpclient.Dial`)는 `DialStdio`로 갱신.
- `DialHTTP(ctx, url, headers)` — 신규(httpTransport 생성 + initialize).

`McpCaller` 인터페이스(agent 패키지)는 변경 없음(`*Client`가 계속 만족).

## 컴포넌트 설계

### A. 엔진 — mcpclient 리팩터 + httpTransport

- `engine/internal/adapters/mcpclient/transport.go`(신규): `transport` 인터페이스 + `stdioTransport`
  (기존 파이프 로직 이전) + `httpTransport`(Streamable HTTP).
- `engine/internal/adapters/mcpclient/client.go`(수정): `Client`가 `t transport`를 보유. protocol
  메서드(`initialize/ListTools/Call/Close`)는 `t`에 위임. `DialStdio`/`DialHTTP` 생성자.
- 단위 테스트: `httpTransport`를 `httptest.Server`로 — (1) JSON 응답, (2) SSE 응답, (3) 사용자 헤더
  첨부 확인, (4) `Mcp-Session-Id` 캡처·재전송 확인. stdio는 기존 fake-pipe 테스트 유지(개명에 맞춰
  `DialStdio`/`newStdio` 경유).

### B. 엔진 — 도메인 + 영속화

```go
// engine/internal/domain/mcpserver.go 확장
type McpServer struct {
    // ... 기존: ID, WorkspaceID, Name, Command, Args, Enabled, Trusted, CreatedAt, UpdatedAt
    Transport string `json:"transport"` // "stdio" | "http" (빈 값/기본 = "stdio")
    URL       string `json:"url"`       // http 전송 시 엔드포인트
}

// 정규화 헬퍼: 빈 Transport는 "stdio"로 간주.
func (s McpServer) TransportKind() string // strings.TrimSpace == "" ? "stdio" : s.Transport
```

- 마이그레이션 v11:
  `ALTER TABLE mcp_servers ADD COLUMN transport TEXT NOT NULL DEFAULT 'stdio';`
  `ALTER TABLE mcp_servers ADD COLUMN url TEXT NOT NULL DEFAULT '';`
  repo 4개 쿼리(Create/List/Update + scan)에 두 컬럼 추가(positional 주의).
- **인증 헤더**는 DB가 아닌 키체인 blob `mcp_headers_<id>`(JSON map). stdio의 `mcp_env_<id>`와
  동일 패턴(시크릿이 SQLite에 안 남음). POST에서 "있을 때만 갱신"(env 패턴 그대로).

### C. 엔진 — 핸들러 + 배선

- `mcpserver.go` POST body 확장: `{..., transport, url, headers map[string]string}`. transport/url은
  테이블에 저장, headers는 키체인(`mcp_headers_<id>`, present-only).
- Dial 분기 헬퍼: 서버의 `TransportKind()`가
  - `http` → `mcpclient.DialHTTP(url, headersFromKeychain)`
  - 그 외 → `mcpclient.DialStdio(command, argsList, envFromKeychain)`
- 적용 지점 3곳: `/agent/run`의 dial 클로저, `/mcp/servers/call`, `/mcp/servers/test`(test는 body의
  transport/url/headers 또는 command/args/env로 직접 dial).
- `headersFor(ctx, serverID)` 헬퍼(envFor와 대칭): `secrets.Get("mcp_headers_"+id)` → JSON.
- **타임아웃 정책**(전송 무관 일관):
  - `/mcp/servers/test`(도구 목록 미리보기): 짧은 타임아웃(15s ctx) — 빠른 피드백용.
  - `/mcp/servers/call`(실제 도구 실행) 및 `/agent/run` 중의 도구 호출: **인위적 캡 없이 요청 ctx를
    그대로 사용**. 외부 도구는 오래 걸릴 수 있으므로(검색·크롤·LLM 위임) 15s 하드캡으로 끊지 않는다.
    `/mcp/servers/call`은 사용자 요청 ctx(브라우저가 살아있는 동안), `/agent/run`은 에이전트 실행
    ctx를 따른다.

### D. 렌더러

- `lib/mcpServerForm.ts`: `parseHeaders(text)` 추가(`Key: Value` 줄 파싱, 빈 줄/`#` 스킵, 첫 `:`
  기준 분리). `validateServer`에 `transport==='http'면 url 필수` 분기 추가(시그니처를
  `{name, command, transport?, url?}`로 확장).
- `components/McpServersPanel.tsx`: 추가 폼에 전송 `<select>`(stdio/http). `http` 선택 시 URL +
  헤더(textarea) 필드 노출, command/args/env 숨김; `stdio`면 현행 필드. 저장 시 transport에 맞는
  payload(`{transport, url, headers}` 또는 `{command, args, env}`) 전송. 목록 행에 전송 배지
  (`stdio`/`http`) + http는 URL 표시. "연결 테스트"는 transport에 맞춰 호출(payload 분기).
- `global.d.ts`: `McpServer`/`McpServerInput`에 `transport?`, `url?`, `headers?` 추가
  (`McpServerInput.command/args/env`는 옵셔널화 — http에선 불필요).

### E. IPC

- 기존 `mcpServersSave/Test/Call` 채널 재사용(스키마만 확장). `mcp-servers-test` payload가 transport에
  따라 `{transport:'http', url, headers}` 또는 `{transport:'stdio', command, args, env}`. main 핸들러는
  그대로 pass-through(엔진이 분기).

## 도구 호출 흐름 (변화 없음)

전송과 무관하게: 신뢰 서버 → `client.Call` 즉시 실행 / 비신뢰 → `{proposed:true,...}` 제안 → 사용자
"실행" → `/mcp/servers/call`. AttachMCPServers·프록시 네임스페이싱·승인 흐름은 sub-project 1 그대로.

## 구현 가드레일 (리뷰 반영)

- **출시된 stdio 코드 회귀 금지**: 전송 추상화 리팩터는 sub-project 1(v0.21.0)의 동작하는 stdio
  경로를 건드린다. 기존 stdio fake-pipe 단위 테스트는 **개명 외 수정 없이 그대로 통과**해야 한다
  (하드 게이트). 별도 `httpClient` 복제 대신 `transport` 인터페이스를 쓰는 이유는 DRY + 2b OAuth
  토큰 주입 지점 확보.

## 에러 처리 / 엣지

- **URL 미입력(http)**: 렌더러 검증 에러("URL을 입력하세요").
- **네트워크 실패/dial 실패**: dial 실패 → warnings 스킵(stdio와 동일, 다른 서버·내장 도구는 정상).
  타임아웃은 위 §C 정책(test=15s, call=요청 ctx)을 따른다.
- **비-2xx HTTP**: 응답 본문을 에러로 표면화.
- **SSE에 매칭 id 없음/스트림 조기 종료**: 에러 반환(루프 계속).
- **세션 헤더 없는 서버**: `Mcp-Session-Id` 미수신 시 생략하고 정상 동작.
- **하위호환**: `Transport` 빈 값 → stdio. 기존 stdio 서버·기존 행 동작 완전 불변.

## 보안

- 인증 헤더(베어러 토큰)는 키체인에만(`mcp_headers_<id>`), DB·목록 응답에 노출 안 함(env와 동일).
- HTTPS 권장. 평문 `http://` URL은 허용하되 사용자 책임(로컬/내부망 서버 대응).
- 헤더 값 CRLF 인젝션: Go `net/http`가 잘못된 헤더 값을 거부하므로 저위험(별도 처리 불필요).
- 기존 secret redaction(연결 비밀번호)·토큰 인증은 무관·불변.

## 범위 경계

**포함(2a):** A~E (Streamable HTTP + 정적 헤더/베어러 인증).

**제외(2b 이후로 연기):**
- OAuth 2.1(Protected Resource/Authorization Server Metadata discovery, 동적 클라이언트 등록,
  PKCE 인가 코드 플로우, 토큰 갱신).
- 레거시 HTTP+SSE(2024-11) 두-엔드포인트 전송.
- MCP `resources`/`prompts`.
- 자동 재연결/세션 재개, 서버측 푸시 알림(streamed notifications) 소비.

## 테스트 전략

- **mcpclient(Go)**: `httpTransport` httptest 기반 — JSON 응답, SSE 응답, 사용자 헤더 첨부,
  Mcp-Session-Id 캡처·재전송, 비-2xx 에러. stdio 기존 테스트는 개명에 맞춰 유지.
- **repo**: 마이그v11 + transport/url 왕복(기존 mcp_servers 테스트 확장).
- **렌더러 순수**: `parseHeaders`(Key: Value, 빈/주석 스킵), `validateServer`(http면 url 필수).
- **컴포넌트**: 빌드/타입체크.
- **CDP 라이브**: 경량 Node Streamable HTTP MCP 서버(echo, 단일 POST 엔드포인트로 initialize/
  tools.list/tools.call에 JSON 응답) fixture → 패널에서 http 서버 추가(URL)→연결 테스트(echo 도구
  확인)→신뢰 설정→에이전트가 `mcp__echo__echo` 호출·결과 확인.

## 완료 기준 (에픽 #36 매핑, HTTP 슬라이스)

- [x] MCP 클라이언트 HTTP/SSE 전송 → A(httpTransport, Streamable HTTP)
- [x] 원격 서버 등록(URL) + UI → B(transport/url) + D(패널 폼)
- [x] 외부 서버 인증/시크릿(키체인) → B(`mcp_headers_<id>`) — 정적 헤더/베어러
- [ ] OAuth 2.1 → **2b(별도 spec)**
- [ ] 레거시 HTTP+SSE 전송 → **범위 외**
