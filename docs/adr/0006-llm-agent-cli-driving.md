# 0006 — Driving local AI CLIs headlessly for Agent Mode

**Status:** Accepted (P0 spike, milestone #2 / issue #9)
**Date:** 2026-06-02

## Context

Agent Mode's `LocalCliAdapter` (see the [design spec](../superpowers/specs/2026-06-02-llm-agent-mode-design.md))
must drive the user's already-installed AI CLI from inside Rebase, reusing their
existing login rather than asking for a separate API key. The open question (#9)
was whether such CLIs can run **non-interactively** with a **usable tool-call
channel** and **auth reuse**.

## Findings (spike)

Probed the local machine:

- **`claude` (Claude Code) is installed**; `codex`, `gemini`, `antigravity` are
  not present here.
- `claude` exposes everything the adapter needs in headless mode:
  - `-p/--print` with `--output-format json|stream-json` and
    `--input-format stream-json` → **bidirectional streaming, multi-turn**.
  - `--mcp-config` → load MCP servers; `--allowedTools/--disallowedTools` →
    restrict the tool surface; `--strict-mcp-config` → ignore ambient MCP config.
  - `--permission-mode` (default / acceptEdits / dontAsk / bypassPermissions /
    plan), `--max-budget-usd` (cost cap), `--model`, `--append-system-prompt`,
    `--json-schema`.
- A headless call returns a clean JSON envelope
  (`{type:"result", result, usage, total_cost_usd, session_id, …}`).
- **Auth reuse could not be positively confirmed from inside the agent harness**:
  the nested invocation hit `401` because the harness environment sets
  `ANTHROPIC_BASE_URL` (a custom gateway) and an empty `ANTHROPIC_API_KEY`, which
  the subprocess inherited. In a normal launch those overrides are absent and the
  CLI uses the user's logged-in OAuth session.

## Decision

1. **Drive `claude` headless via `stream-json` over stdin/stdout** —
   `claude -p --input-format stream-json --output-format stream-json`. Rebase
   writes user turns to stdin and renders streamed assistant text + tool events
   from stdout. This **supersedes the original "structured tool-call protocol over
   CLI text" (#11)** — no fragile text parsing.
2. **Expose Rebase's DB operations as an MCP (stdio) server** — the single shared
   tool layer. The CLI is launched with `--mcp-config <rebase-mcp>` and
   `--allowedTools "mcp__rebase__*"` (+ `--strict-mcp-config`); **claude runs the
   agent loop and calls our tools**. The Direct API adapter reuses the same tool
   implementations as native function-calling.
3. **Spawn with a sanitized environment** — unset `ANTHROPIC_BASE_URL`,
   `ANTHROPIC_API_KEY`, and harness `CLAUDE_CODE_*` vars so the user's real login
   is used. (This is exactly what caused the spike's 401.)
4. **Map safety policies to CLI flags**: autonomy/data-exposure via
   `--permission-mode` + `--allowedTools` + the MCP server's own gating;
   cost ceiling via `--max-budget-usd`.

## Consequences

- One tool catalog, two providers: CLI path dispatches tools via MCP (loop owned
  by `claude`); Direct API path dispatches the same tools itself (loop owned by
  Rebase's `AgentService`).
- `LocalCliAdapter` is **claude-first**. `codex` (`codex exec` + MCP) and others
  are added later behind the same `LLMProvider` port when present.
- Provider onboarding (#16) must detect the CLI, its login state, and surface
  actionable errors (not installed / not logged in).

## To validate before P4

- Auth reuse + sanitized-env spawn in a **real (non-nested) launch**.
- Exact `--permission-mode` semantics vs the approval/autonomous policy mapping.
- `stream-json` event schema coverage (tool-use, tool-result, partial text,
  result envelope) against our renderer trace.
