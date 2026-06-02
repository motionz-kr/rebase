# Agent P4 — Local-CLI Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. **Must be executed in the user's real environment** (a normally-launched shell with a logged-in `claude` CLI) — the agent sandbox cannot run `claude` headless (nested auth 401; see ADR 0006).

**Goal:** Add a `LocalCliProvider` so Agent Mode can run on the user's logged-in `claude` CLI instead of a Direct API key, by exposing Rebase's DB tools as an MCP server and driving `claude -p` with stream-json.

**Architecture (from ADR 0006):** Rebase spawns `claude` headless with `--input-format stream-json --output-format stream-json --mcp-config <rebase-mcp> --allowedTools "mcp__rebase__*" --permission-mode <policy>` and a **sanitized environment** (drop `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_*`). `claude` runs the agent loop and calls our tools over MCP; Rebase pipes user turns to stdin and renders streamed events from stdout. The MCP server reuses the existing `agent.Registry` tools — one tool implementation, two providers.

**Tech Stack:** Go (stdlib `os/exec`, `encoding/json`, `bufio`); JSON-RPC 2.0 over stdio for MCP. No new deps.

---

## Task 1: MCP stdio server exposing the registry (TDD)

**Files:** Create `engine/internal/adapters/mcp/server.go` + `server_test.go`.

- [ ] Implement a JSON-RPC 2.0 stdio loop handling `initialize`, `tools/list`, `tools/call`.
- [ ] `tools/list` returns `registry.Specs()` mapped to MCP tool schema (`name`, `description`, `inputSchema`).
- [ ] `tools/call` dispatches to `registry.Dispatch(name, args)` and returns the result as MCP `content` (`[{type:"text", text:<json>}]`).
- [ ] **TDD (no subprocess):** feed framed JSON-RPC requests through an `io.Reader`/`io.Writer` pair and assert the responses (initialize handshake, tools/list contains `list_tables`, tools/call runs a tool via a fake registry). This is fully unit-testable offline.

## Task 2: MCP entrypoint in the engine binary

**Files:** Modify `engine/cmd/app-engine/main.go`.

- [ ] Add a `-mcp <profileId>` mode: when set, the binary runs the MCP server (Task 1) over stdio against that profile's connector instead of the HTTP server. `claude` launches this same binary as the MCP server.

## Task 3: `LocalCliProvider` (spawn + stream-json)

**Files:** Create `engine/internal/adapters/llm/cli.go` + `cli_stream_test.go`.

- [ ] `decodeClaudeStreamLine(line []byte, state) []ports.LLMEvent` — pure parser for `claude --output-format stream-json` lines (`{"type":"assistant",...}` with text/tool_use content, `{"type":"result",...}`, `{"type":"system",...}`). **TDD with fixtures captured from a real `claude` run** (capture in the user's env first).
- [ ] `LocalCliProvider.Complete` spawns `claude -p --input-format stream-json --output-format stream-json --mcp-config <generated> --allowedTools "mcp__rebase__*" --strict-mcp-config --permission-mode <map(policy)> --max-budget-usd <cap>` with a **sanitized env**, writes the request as stream-json to stdin, and pipes stdout through `decodeClaudeStreamLine`.
- [ ] `Status` checks `claude` is on PATH and logged in (`claude --version` / a cheap probe).

## Task 4: Wire provider selection + onboarding

**Files:** `transport/http/agent.go`, renderer `AgentChat` settings.

- [ ] `provider: "cli"` selects `LocalCliProvider`. Renderer settings gain a "Local CLI (claude)" option with detection/onboarding errors (not installed / not logged in) — completes #16.

## Task 5: Live verification (user environment — REQUIRED)

- [ ] Launch the packaged/dev app normally; confirm `claude` auth is reused (no key prompt).
- [ ] Capture real stream-json fixtures; confirm Task 3 decoder covers them.
- [ ] CDP/manual: "how many tables?" via the CLI provider → `claude` calls `mcp__rebase__list_tables` → streamed answer. Confirm `--permission-mode` maps to the approval/autonomous policy and `--max-budget-usd` caps cost.

---

## Notes / risks
- Capturing real stream-json fixtures (Task 3) must happen first in a live run — do not guess the schema.
- `--permission-mode` ↔ policy mapping and MCP `allowedTools` scoping are the safety surface; verify writes still route through approval.
- `codex`/`gemini` adapters follow the same shape later (codex: `codex exec` + MCP).
