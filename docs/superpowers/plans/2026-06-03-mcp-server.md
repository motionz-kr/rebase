# MCP Server (External Gateway) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Rebase's DB tools to external AI clients (Claude Desktop, Codex, Cursor) over stdio MCP — opt-in per connection, governed by the agent's data-exposure + secret-redaction policy, with a copy-paste config snippet and one-click auto-connect.

**Architecture:** Reuse the existing `mcp.Server` (stdio JSON-RPC) and `agent` policy. P1 makes the server policy-aware and adds per-connection MCP settings on the profile. P2 builds the onboarding UI (toggle + exposure + snippet). P3 adds auto-connect (detect + safe-merge into client configs, JSON for Claude/Cursor, TOML for Codex). P4 docs + live verify.

**Tech Stack:** Go engine, SQLite migrations, Electron main (Node fs), React renderer, vitest, `@iarna/toml`.

**Spec:** `docs/superpowers/specs/2026-06-03-mcp-server-design.md`

---

## Phase P1 — Policy-aware MCP server + per-connection settings

### Task 1: Export the agent policy helpers (share with MCP)

**Files:**
- Modify: `engine/internal/agent/service.go`

- [ ] **Step 1: Rename the unexported helpers to exported and update callers**

In `engine/internal/agent/service.go`, rename `sanitizeForPolicy` → `SanitizeForPolicy` and `redact` → `Redact` (exported), updating their call sites inside `service.go` (`request()` uses `redact`; the loop uses `sanitizeForPolicy`). Signatures unchanged:

```go
func SanitizeForPolicy(toolName string, result any, p Policy) any { /* existing body */ }
func Redact(text string, secrets []string) string { /* existing body */ }
```

- [ ] **Step 2: Verify the agent package still builds + tests pass**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/agent/`
Expected: PASS (existing tests, now calling the renamed helpers).

- [ ] **Step 3: Commit**

```bash
git add engine/internal/agent/service.go
git commit -m "refactor(agent): export SanitizeForPolicy + Redact for reuse"
```

### Task 2: Make the MCP server policy-aware (TDD)

**Files:**
- Modify: `engine/internal/adapters/mcp/server.go`
- Test: `engine/internal/adapters/mcp/server_test.go`

- [ ] **Step 1: Write the failing test**

Add to `server_test.go` (uses the package's existing `fakeSQL`-style registry helper; if the test file builds a registry via `agent.NewSQLRegistry`, reuse that). The test calls `tools/call` for `run_select` under a `metadata` policy and asserts cell values are withheld:

```go
func TestServerAppliesDataExposurePolicy(t *testing.T) {
	reg := agent.NewSQLRegistry(&fakeReader{rows: [][]any{{1, "alice"}}, cols: []string{"id", "name"}}, domainProfile(), "", "devdb")
	s := mcp.NewServer(reg)
	s.SetPolicy(agent.Policy{DataExposure: "metadata"}, []string{"secretpw"})

	call := []byte(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"run_select","arguments":{"sql":"SELECT * FROM users"}}}`)
	resp := s.Handle(context.Background(), call)
	body, _ := json.Marshal(resp.Result)
	if strings.Contains(string(body), "alice") {
		t.Errorf("metadata policy must withhold cell values, leaked: %s", body)
	}
	if !strings.Contains(string(body), "withheld") {
		t.Errorf("expected a withheld summary, got: %s", body)
	}
}
```

(If the existing `server_test.go` already has registry/fake helpers, reuse them rather than redefining; only add the new test + any missing fake.)

- [ ] **Step 2: Run it — verify it fails**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/mcp/ -run TestServerAppliesDataExposurePolicy`
Expected: FAIL — `s.SetPolicy` undefined.

- [ ] **Step 3: Implement policy on the server**

In `server.go`, add fields + setter and apply in `tools/call`:

```go
type Server struct {
	registry *agent.Registry
	policy   agent.Policy
	secrets  []string
}

// SetPolicy configures the data-exposure gate + secret redaction applied to
// tool results before they leave the server.
func (s *Server) SetPolicy(p agent.Policy, secrets []string) { s.policy = p; s.secrets = secrets }
```

Replace the `tools/call` success branch:

```go
		result, err := s.registry.Dispatch(ctx, p.Name, p.Arguments)
		if err != nil {
			return reply(map[string]any{
				"content": []map[string]any{{"type": "text", "text": err.Error()}},
				"isError": true,
			})
		}
		b, _ := json.Marshal(agent.SanitizeForPolicy(p.Name, result, s.policy))
		text := agent.Redact(string(b), s.secrets)
		return reply(map[string]any{
			"content": []map[string]any{{"type": "text", "text": text}},
		})
```

- [ ] **Step 4: Run it — verify it passes**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/mcp/`
Expected: PASS (new + existing tests).

- [ ] **Step 5: Commit**

```bash
git add engine/internal/adapters/mcp/server.go engine/internal/adapters/mcp/server_test.go
git commit -m "feat(mcp): apply data-exposure policy + secret redaction to results (TDD)"
```

### Task 3: Add MCP fields to the connection profile + repo (TDD)

**Files:**
- Modify: `engine/internal/domain/connection.go`
- Modify: `engine/internal/adapters/sqlite/sqlite_profile_repository.go`
- Test: `engine/internal/adapters/sqlite/sqlite_profile_repository_test.go`

- [ ] **Step 1: Add domain fields**

In `connection.go`, add to `ConnectionProfile`:

```go
	McpEnabled      bool   `json:"mcpEnabled"`
	McpDataExposure string `json:"mcpDataExposure"` // metadata|on_request|unrestricted (default metadata)
```

- [ ] **Step 2: Write the failing repo round-trip test**

Add to `sqlite_profile_repository_test.go` a test that creates a profile with `McpEnabled=true, McpDataExposure="unrestricted"`, reads it back, and asserts both fields persist. (Mirror the existing create/get test; the test DB is built with the migrations including the new v3 from Task 4 — so order Task 4's migration before running this; if the test bootstraps its own schema, add the columns there too.)

```go
func TestProfileMCPFieldsRoundTrip(t *testing.T) {
	repo, cleanup := newTestProfileRepo(t) // existing helper
	defer cleanup()
	p := &domain.ConnectionProfile{ID: "p1", Name: "x", Driver: "mysql", Host: "h", Port: 3306, Database: "d", Username: "u", SecretRef: "s", TLSMode: "none", McpEnabled: true, McpDataExposure: "unrestricted", CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := repo.Create(context.Background(), p); err != nil { t.Fatal(err) }
	got, err := repo.GetByID(context.Background(), "p1")
	if err != nil { t.Fatal(err) }
	if !got.McpEnabled || got.McpDataExposure != "unrestricted" {
		t.Errorf("mcp fields not persisted: %+v", got)
	}
}
```

- [ ] **Step 3: Run it — verify it fails**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/sqlite/ -run TestProfileMCPFieldsRoundTrip`
Expected: FAIL — columns/scan missing.

- [ ] **Step 4: Update the repo SQL**

In `sqlite_profile_repository.go`, add `mcp_enabled, mcp_data_exposure` to the column lists in Create/GetByID/List/Update, scan into `&p.McpEnabled, &p.McpDataExposure`, and bind `p.McpEnabled, p.McpDataExposure`. (Create + Update add two `?` placeholders + values; Get/List add the two columns to SELECT + Scan.)

- [ ] **Step 5: Ensure the test schema has the columns**

If `newTestProfileRepo` builds the schema inline, add `mcp_enabled INTEGER NOT NULL DEFAULT 0, mcp_data_exposure TEXT NOT NULL DEFAULT 'metadata'` to its `CREATE TABLE`. (If it runs the real migrations, Task 4 covers it.)

- [ ] **Step 6: Run it — verify it passes**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/sqlite/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add engine/internal/domain/connection.go engine/internal/adapters/sqlite/sqlite_profile_repository.go engine/internal/adapters/sqlite/sqlite_profile_repository_test.go
git commit -m "feat(profile): persist per-connection MCP settings (TDD)"
```

### Task 4: Migration v3 + policy-aware runMCPServer + set-settings endpoint

**Files:**
- Modify: `engine/cmd/app-engine/main.go`
- Modify: `engine/internal/application/connection_service.go`
- Modify: `engine/internal/transport/http/agent.go` (or a small new handler)

- [ ] **Step 1: Add migration v3**

In `main.go` `migrations` slice, append:

```go
		{
			Version: 3,
			Name:    "add_profile_mcp_settings",
			SQL: `
				ALTER TABLE connection_profiles ADD COLUMN mcp_enabled INTEGER NOT NULL DEFAULT 0;
				ALTER TABLE connection_profiles ADD COLUMN mcp_data_exposure TEXT NOT NULL DEFAULT 'metadata';
			`,
			Checksum: "profile-mcp-settings-v1",
		},
```

- [ ] **Step 2: Make runMCPServer refuse-if-disabled + apply policy**

In `runMCPServer`, after loading the profile:

```go
	if !profile.McpEnabled {
		log.Fatalf("mcp: connection %q is not enabled for MCP (enable it in Rebase → connection settings)", profileID)
	}
	...
	registry := agent.NewSQLRegistry(conn, *profile, password, profile.Database)
	exposure := profile.McpDataExposure
	if exposure == "" { exposure = "metadata" }
	srv := mcp.NewServer(registry)
	srv.SetPolicy(agent.Policy{DataExposure: exposure}, []string{password, profile.SecretRef})
	if err := srv.Serve(ctx, os.Stdin, os.Stdout); err != nil { log.Fatalf("mcp: server error: %v", err) }
```

- [ ] **Step 3: Add SetMCPSettings to ConnectionService**

In `connection_service.go`:

```go
// SetMCPConnectionSettings toggles MCP exposure + data-exposure for a profile.
func (s *ConnectionService) SetMCPConnectionSettings(ctx context.Context, id string, enabled bool, dataExposure string) error {
	p, err := s.repo.GetByID(ctx, id)
	if err != nil { return err }
	if dataExposure == "" { dataExposure = "metadata" }
	p.McpEnabled = enabled
	p.McpDataExposure = dataExposure
	return s.repo.Update(ctx, p)
}
```

- [ ] **Step 4: Add HTTP route `POST /mcp/connection`**

Add a handler (in `agent.go` next to the agent handler, which already holds the ConnectionService, or a small `mcp.go`):

```go
// POST /mcp/connection {profileId, enabled, dataExposure}
func (h *AgentHandler) SetMCPConnection() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.checkToken(r) { http.Error(w, "Unauthorized", 401); return }
		var b struct{ ProfileID string `json:"profileId"`; Enabled bool `json:"enabled"`; DataExposure string `json:"dataExposure"` }
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil { http.Error(w, "invalid body", 400); return }
		if err := h.service.SetMCPConnectionSettings(r.Context(), b.ProfileID, b.Enabled, b.DataExposure); err != nil { http.Error(w, err.Error(), 400); return }
		w.Header().Set("Content-Type", "application/json"); _ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})
}
```

Register in `main.go`: `mux.Handle("/mcp/connection", agentHandler.SetMCPConnection())`.

- [ ] **Step 5: Build + full engine test**

Run: `/Users/smlee/sdk/go/bin/go build ./engine/... && /Users/smlee/sdk/go/bin/go test ./engine/...`
Expected: build OK; tests PASS (sqlite/agent/mcp incl. live DB suites).

- [ ] **Step 6: Commit**

```bash
git add engine/cmd/app-engine/main.go engine/internal/application/connection_service.go engine/internal/transport/http/agent.go
git commit -m "feat(mcp): migration + policy-aware -mcp entrypoint + set-settings endpoint"
```

---

## Phase P2 — Onboarding UI (toggle + exposure + snippet)

### Task 5: Pure MCP config-snippet builder (TDD)

**Files:**
- Create: `apps/renderer/src/lib/mcpConfig.ts`
- Test: `apps/renderer/src/lib/mcpConfig.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildMcpEntry, mcpServerKey } from './mcpConfig';

describe('mcpConfig', () => {
  it('namespaces the server key by connection id', () => {
    expect(mcpServerKey('abc')).toBe('rebase-abc');
  });
  it('builds a stdio entry with engine path + profile args', () => {
    const e = buildMcpEntry('/Apps/Rebase/bin/app-engine', 'abc');
    expect(e.command).toBe('/Apps/Rebase/bin/app-engine');
    expect(e.args).toEqual(['-mcp', 'abc', '-token', 'mcp', '-handshake', '/dev/null']);
  });
});
```

- [ ] **Step 2: Run it — verify it fails** — `pnpm --filter renderer test -- mcpConfig` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
export const mcpServerKey = (connId: string) => `rebase-${connId}`;

export interface McpEntry {
  command: string;
  args: string[];
}

export function buildMcpEntry(enginePath: string, profileId: string): McpEntry {
  return { command: enginePath, args: ['-mcp', profileId, '-token', 'mcp', '-handshake', '/dev/null'] };
}

// Full snippet for JSON-config clients (Claude Desktop / Cursor).
export function buildJsonSnippet(enginePath: string, connId: string): string {
  return JSON.stringify({ mcpServers: { [mcpServerKey(connId)]: buildMcpEntry(enginePath, connId) } }, null, 2);
}
```

- [ ] **Step 4: Run it — verify it passes** — `pnpm --filter renderer test -- mcpConfig` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/renderer/src/lib/mcpConfig.ts apps/renderer/src/lib/mcpConfig.test.ts
git commit -m "feat(mcp): pure MCP config-snippet builder (TDD)"
```

### Task 6: Engine-path + set-settings IPC (main + preload + types)

**Files:**
- Modify: `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, `apps/renderer/src/global.d.ts`

- [ ] **Step 1: main IPC**

In `index.ts`:

```ts
import * as os from 'os';
function engineBinaryPath(): string {
  return isDev
    ? path.join(__dirname, '..', '..', 'bin', 'app-engine')
    : path.join(process.resourcesPath, 'bin', 'app-engine');
}
ipcMain.handle('mcp-engine-path', () => engineBinaryPath());
ipcMain.handle('mcp-set-settings', (_e, profileId: string, enabled: boolean, dataExposure: string) =>
  engineKeyRequest('POST', '', undefined) // replaced below
);
```

Reuse the existing engine HTTP helper pattern; add a small request to `POST /mcp/connection`:

```ts
ipcMain.handle('mcp-set-settings', (_e, profileId: string, enabled: boolean, dataExposure: string) => {
  return new Promise((resolve) => {
    if (!engineManager || engineManager.getPort() === null) return resolve({ success: false, error: 'Engine not started' });
    const payload = JSON.stringify({ profileId, enabled, dataExposure });
    const req = http.request({ host: '127.0.0.1', port: engineManager.getPort()!, path: '/mcp/connection', method: 'POST',
      headers: { 'X-App-Engine-Token': launchToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload).toString() } },
      (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(res.statusCode && res.statusCode<400 ? {success:true} : {success:false,error:d})); });
    req.on('error', (e) => resolve({ success: false, error: e.message }));
    req.write(payload); req.end();
  });
});
```

- [ ] **Step 2: preload + types**

preload: `mcpEnginePath: () => ipcRenderer.invoke('mcp-engine-path')`, `mcpSetSettings: (id,en,dx)=>ipcRenderer.invoke('mcp-set-settings',id,en,dx)`.
global.d.ts: `mcpEnginePath: () => Promise<string>; mcpSetSettings: (profileId: string, enabled: boolean, dataExposure: string) => Promise<ResultWrapper<{}>>;`

- [ ] **Step 3: Build both** — `pnpm --filter desktop build && pnpm --filter renderer build` → OK.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/renderer/src/global.d.ts
git commit -m "feat(mcp): engine-path + set-settings IPC"
```

### Task 7: `McpConnectPanel` component + wire into connection settings

**Files:**
- Create: `apps/renderer/src/components/McpConnectPanel.tsx`
- Modify: the connection settings surface (locate the connection edit/settings dialog in `apps/renderer/src/App.tsx` or its connection component) + `App.css`

- [ ] **Step 1: Build the panel** — toggle (calls `mcpSetSettings(id, enabled, dataExposure)`), data-exposure `<select>`, snippet `<pre>` from `buildJsonSnippet(enginePath, connId)` with a copy button (`navigator.clipboard.writeText`). `enginePath` fetched via `mcpEnginePath()` in a `useEffect`. Auto-connect buttons are added in P3 (leave a placeholder div).

- [ ] **Step 2: Mount it** in the connection settings/edit dialog (find where a connection's details/edit renders; add a collapsible "AI 클라이언트 연결 (MCP)" section showing the panel for the selected connection).

- [ ] **Step 3: Build + lint** — `pnpm --filter renderer build && pnpm --filter renderer lint` → OK, 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/renderer/src/components/McpConnectPanel.tsx apps/renderer/src/App.tsx apps/renderer/src/App.css
git commit -m "feat(mcp): connection MCP panel — toggle, exposure, copy snippet"
```

---

## Phase P3 — Auto-connect (detect + safe merge)

### Task 8: Add the TOML dependency

**Files:** `apps/desktop/package.json`

- [ ] **Step 1:** `pnpm --filter desktop add @iarna/toml@2.2.5`
- [ ] **Step 2: verify** `pnpm --filter desktop exec node -e "require('@iarna/toml'); console.log('ok')"` → `ok`
- [ ] **Step 3: commit** `git add apps/desktop/package.json pnpm-lock.yaml && git commit -m "build(desktop): add @iarna/toml for codex config merge"`

### Task 9: Pure JSON safe-merge (TDD)

**Files:**
- Create: `apps/desktop/src/main/mcpMerge.ts`
- Test: `apps/desktop/src/main/mcpMerge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mergeJsonMcp } from './mcpMerge';

describe('mergeJsonMcp', () => {
  it('adds our key, preserving other servers and keys', () => {
    const existing = { theme: 'dark', mcpServers: { other: { command: 'x' } } };
    const out = mergeJsonMcp(existing, 'rebase-abc', { command: '/e', args: ['-mcp', 'abc'] });
    expect(out.theme).toBe('dark');
    expect(out.mcpServers.other).toEqual({ command: 'x' });
    expect(out.mcpServers['rebase-abc']).toEqual({ command: '/e', args: ['-mcp', 'abc'] });
  });
  it('is idempotent (overwrites only our key)', () => {
    const a = mergeJsonMcp({}, 'rebase-abc', { command: '/e', args: [] });
    const b = mergeJsonMcp(a, 'rebase-abc', { command: '/e2', args: [] });
    expect(b.mcpServers['rebase-abc'].command).toBe('/e2');
    expect(Object.keys(b.mcpServers)).toEqual(['rebase-abc']);
  });
});
```

- [ ] **Step 2: run → fail** — `pnpm --filter desktop test -- mcpMerge`
- [ ] **Step 3: Implement**

```ts
export interface McpEntry { command: string; args: string[] }
export function mergeJsonMcp(existing: any, key: string, entry: McpEntry): any {
  const cfg = existing && typeof existing === 'object' ? { ...existing } : {};
  cfg.mcpServers = { ...(cfg.mcpServers || {}), [key]: entry };
  return cfg;
}
```

- [ ] **Step 4: run → pass**
- [ ] **Step 5: commit** `git add apps/desktop/src/main/mcpMerge.* && git commit -m "feat(mcp): pure JSON config safe-merge (TDD)"`

### Task 10: Pure TOML safe-merge (TDD)

**Files:** `apps/desktop/src/main/mcpMerge.ts` (extend) + test

- [ ] **Step 1: Write the failing test**

```ts
import { mergeTomlMcp } from './mcpMerge';
it('merges into codex TOML preserving other tables', () => {
  const existing = '[mcp_servers.other]\ncommand = "x"\n\n[settings]\nmodel = "gpt"\n';
  const out = mergeTomlMcp(existing, 'rebase-abc', { command: '/e', args: ['-mcp', 'abc'] });
  expect(out).toContain('[mcp_servers.other]');
  expect(out).toContain('[mcp_servers.rebase-abc]');
  expect(out).toContain('model = "gpt"');
});
```

- [ ] **Step 2: run → fail**
- [ ] **Step 3: Implement** (using `@iarna/toml`)

```ts
import TOML from '@iarna/toml';
export function mergeTomlMcp(existingToml: string, key: string, entry: McpEntry): string {
  const cfg: any = existingToml.trim() ? TOML.parse(existingToml) : {};
  cfg.mcp_servers = { ...(cfg.mcp_servers || {}), [key]: { command: entry.command, args: entry.args } };
  return TOML.stringify(cfg);
}
```

- [ ] **Step 4: run → pass**
- [ ] **Step 5: commit** `git add apps/desktop/src/main/mcpMerge.* && git commit -m "feat(mcp): pure TOML config safe-merge for codex (TDD)"`

### Task 11: Client registry + detect + auto-connect IPC

**Files:**
- Create: `apps/desktop/src/main/mcpClients.ts`
- Modify: `apps/desktop/src/main/index.ts`, preload, `global.d.ts`

- [ ] **Step 1: Client registry + detect + apply**

`mcpClients.ts`: a registry mapping `claude|cursor|codex` → `{ label, format: 'json'|'toml', path() }` using `os.homedir()`/`process.env.APPDATA`:
- claude: mac `~/Library/Application Support/Claude/claude_desktop_config.json`, win `%APPDATA%/Claude/claude_desktop_config.json`
- cursor: `~/.cursor/mcp.json`
- codex: `~/.codex/config.toml`

`detectClients()` → list of `{id, label, present}` (present = config dir or file exists). `applyClient(id, key, entry)` → read existing (or ''), write `.bak` backup if file exists, merge via `mergeJsonMcp`/`mergeTomlMcp`, validate parse, write file (create dirs as needed).

- [ ] **Step 2: IPC** — `mcp-detect-clients` → `detectClients()`; `mcp-autoconnect` `(clientId, profileId, connName)` → builds entry via the same args as `buildMcpEntry` (engine path + `-mcp <id> ...`) and calls `applyClient`. Return `{success, backupPath?}` or `{success:false,error}`.

- [ ] **Step 3: preload + types** — `mcpDetectClients()`, `mcpAutoconnect(clientId, profileId)`.

- [ ] **Step 4: Build** — `pnpm --filter desktop build` → OK. `pnpm --filter desktop test` → mcpMerge tests green.

- [ ] **Step 5: commit** `git add apps/desktop/src/main/mcpClients.ts apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/renderer/src/global.d.ts && git commit -m "feat(mcp): client detection + auto-connect (Claude/Cursor/Codex)"`

### Task 12: Wire auto-connect buttons into the panel

**Files:** `apps/renderer/src/components/McpConnectPanel.tsx`

- [ ] **Step 1:** On mount, `mcpDetectClients()` → render a "Connect to {label}" button per client (disabled + "not detected" when `present=false`). Click → `mcpAutoconnect(clientId, connId)` → toast success (+ backup note) or error. Keep the copy-snippet as fallback.
- [ ] **Step 2: Build + lint** → OK.
- [ ] **Step 3: commit** `git add apps/renderer/src/components/McpConnectPanel.tsx && git commit -m "feat(mcp): one-click auto-connect buttons in the panel"`

---

## Phase P4 — Docs + live verification

### Task 13: Live-verify the full flow (CDP + real client)

- [ ] **Step 1:** Rebuild engine → `apps/desktop/bin/app-engine`; `pnpm --filter desktop build`; restart Electron (CDP 9222).
- [ ] **Step 2:** Via CDP: open a connection's MCP panel, toggle **Expose via MCP** on for the dev-mysql connection, set exposure `metadata`. Assert `mcpSetSettings` succeeded (profile list shows `mcpEnabled=true`).
- [ ] **Step 3:** Verify the server end-to-end with a real MCP handshake: run the bundled engine in -mcp mode and send `initialize` + `tools/list` + a `run_select` `tools/call`, asserting the result is **withheld** (no cell values) under `metadata`:

```bash
printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"run_select","arguments":{"sql":"SELECT * FROM demo_users"}}}' \
 | apps/desktop/bin/app-engine -mcp <dev-mysql-profileId> -token mcp -handshake /dev/null
```

Expected: initialize result, a tools array, and a `tools/call` result whose text contains `withheld`/`rowCount` but **not** `Alice`.

- [ ] **Step 4:** Click "Connect to Codex" (codex is installed); confirm `~/.codex/config.toml` gains `[mcp_servers.rebase-<id>]`, other tables intact, and a `.bak` exists. (Use a temp HOME or restore the backup afterward to avoid mutating the user's real codex config — verify against a copy.)
- [ ] **Step 5:** If any assertion fails, fix the relevant unit and re-run.

### Task 14: Docs

**Files:** Create `docs/mcp-server.md`

- [ ] **Step 1:** Write `docs/mcp-server.md`: what it is, per-connection enable + data-exposure, the copy-paste snippet, auto-connect (Claude Desktop/Codex/Cursor) + where each config lives, the security model (local trust boundary, metadata default, non-mutating tools, backups), and "moving the app breaks paths → re-run auto-connect".
- [ ] **Step 2: commit** `git add docs/mcp-server.md && git commit -m "docs: MCP server (external clients) guide"`

### Task 15: Full regression + PR

- [ ] **Step 1:** `pnpm --filter renderer test && pnpm --filter renderer lint && pnpm --filter renderer build`; `pnpm --filter desktop test && pnpm --filter desktop build`; `/Users/smlee/sdk/go/bin/go test ./engine/...`. All green.
- [ ] **Step 2:** `git push -u origin feat/mcp-server`; open PR `feat(mcp): expose Rebase to external AI clients` into main. The release-please flow cuts the next version on merge.

---

## Notes for the implementer

- **Go path:** `/Users/smlee/sdk/go/bin/go` (not on PATH).
- **Engine rebuild for the app:** `go build -o apps/desktop/bin/app-engine ./engine/cmd/app-engine`, then restart Electron (kill `--remote-debugging-port=9222`, relaunch).
- **Don't mutate the user's real client configs** in tests — verify against copies / temp HOME, restore from `.bak`.
- **Conventional Commits** (release-please depends on them); co-author trailer on every commit.
- **Branch protection:** merge via PR; CI (`checks`) must pass.
