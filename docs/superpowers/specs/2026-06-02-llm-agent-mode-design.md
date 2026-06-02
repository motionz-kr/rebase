# LLM Agent Mode — Design

**Status:** Draft (brainstorming output, pending review)
**Milestone:** #2 (issues #9–#16)
**Date:** 2026-06-02

## Goal

Add an in-app AI assistant to Rebase that answers natural-language questions about
the connected database and — when the user allows — writes/optimizes SQL and
executes schema/data changes, all behind explicit, user-configurable safety and
privacy policies. The model is driven through a provider abstraction so Rebase can
use either a direct cloud API key or the user's already-logged-in local AI CLIs.

## Context

Rebase already exposes, through the Go engine, exactly the primitives an agent
needs as tools — these are **reused, not rebuilt**:

- Schema: `ListDatabases`, `ListTables`, `ListViews`, `DescribeTable`,
  `GetTableDDL`, `GetViewDDL`, `ListColumns`, `ListForeignKeys`, `ListIndexes`.
- Data / execution: `ExecuteQueryStream` (with a `readOnly` flag + row cap),
  `ExecuteBatch` (transactional, all-or-nothing with rollback), `CancelSession`.
- Redis: scan / value / set / del / expire / rename / command.

Secrets already live in the OS keychain and never transit the renderer in
plaintext; the agent must preserve this.

The codebase follows Clean Architecture (domain / application / ports / adapters /
transport·http) with per-driver adapters behind ports. The agent design mirrors
this: a new `LLMProvider` port with swappable adapters.

## Decisions (from brainstorming)

| Axis | Decision |
| --- | --- |
| Autonomy | **User-configurable**: *Approval* (writes only proposed; user clicks Run) ↔ *Autonomous* (writes auto-run; dangerous ops still confirm). Safe default = Approval. |
| Data exposure to the model | **User-configurable**: *Metadata-only* (default) ↔ *Results on request* ↔ *Unrestricted*. Controls whether query **results** re-enter the LLM context. |
| LLM backend | **`LLMProvider` port** with **two adapters shipped**: Direct API (Anthropic/OpenAI key) and Local-CLI wrap (claude/codex). Direct API is the proven path; CLI viability is gated by the P0 spike. |
| Context strategy | Schema is **not** dumped wholesale; the agent fetches what it needs via function-calling tools (token-cheap, aligns with metadata-only privacy). |
| UI | **Right chat panel by default**, switchable to a **dedicated pop-out tab**. (Inline Cmd+K deferred to v1.1.) |
| v1 capability scope | Explore+query, query authoring, diagnostics, and gated writes — all four. |

## Architecture

```
renderer (Chat panel / pop-out tab, settings)
   └─ IPC ──► desktop main
                 └─► engine: AgentService
                      ├─ LLMProvider (port)
                      │     ├─ DirectApiAdapter   (Anthropic / OpenAI, key in keychain)
                      │     └─ LocalCliAdapter     (spawn claude/codex headless)  ← P0 spike
                      ├─ ToolRuntime  ──► existing SQLConnector / RedisConnector
                      └─ PolicyEngine (autonomy + data-exposure gates)
```

**Agent loop (one turn):**
1. Renderer sends the user message + session/policy context over IPC.
2. `AgentService` calls the selected `LLMProvider` with the conversation and the
   tool catalog (filtered by capability + policy).
3. The model replies with either text (streamed to the UI) or tool calls.
4. `ToolRuntime` runs each tool against the **current connection**, applying the
   `PolicyEngine` (e.g. a write tool in Approval mode returns a *proposal*, not a
   side effect; results are withheld from the model under Metadata-only).
5. Tool results feed back to the model; loop until a final answer or `maxSteps` /
   user cancel.

All model output is streamed; tool calls are surfaced as a collapsible trace.

### `LLMProvider` port (shape)

```go
type LLMProvider interface {
    // Streams a completion. Implementations translate the neutral request
    // (messages + tool specs) to/from their wire format and surface tool calls.
    Complete(ctx context.Context, req LLMRequest, on LLMEvent) error
    // Health: is this provider usable right now? (key present / CLI installed + logged in)
    Status(ctx context.Context) (ProviderStatus, error)
}
```

- `DirectApiAdapter`: HTTPS to Anthropic/OpenAI; API key stored in the keychain
  like a connection secret; native tool-calling JSON.
- `LocalCliAdapter`: spawns the CLI in a non-interactive/print mode and exchanges
  a structured tool-call protocol over stdout/stdin. **Feasibility and exact
  protocol are the subject of the P0 spike (#9).** If the spike fails, the port
  still ships with Direct API and CLI is dropped/redesigned.

## Tool catalog (= capabilities)

Tools are thin wrappers over existing engine operations. Each has a JSON schema
exposed to the model; the runtime validates args before dispatch.

**Explore (read, always allowed):**
`list_databases`, `list_tables(db, pattern?)`, `count_tables(db)`,
`describe_table(db, table)`, `get_table_ddl(db, table)`, `list_views(db)`,
`get_view_ddl(db, view)`, `list_indexes(db, table)`,
`list_foreign_keys(db, table)`, `find_column(db, name)` (cross-table reverse lookup).

**Query (read):**
`run_select(sql)` — forced read-only + row cap; `profile_table(db, table)` —
row count, per-column null% / distinct (built from aggregate queries).

**Diagnostics:**
`explain_query(sql)`, `table_stats(db, table)` (size, row estimate),
`find_unused_indexes(db)`, `find_duplicate_indexes(db, table)`,
`slow_queries(limit)` — DB-specific (`performance_schema` / `pg_stat_statements`);
degrade gracefully when the source is unavailable.

**Query authoring:** mostly model-native (NL→SQL, explain, optimize, fix-error);
backed by `explain_query` for validation. Output is offered to the editor, not
auto-run.

**Write (policy-gated):**
`propose_ddl(sql)` / `propose_dml(sql)` — return a preview + estimated affected
rows; execution goes through existing `ExecuteBatch` (transaction + rollback)
only after approval (Approval mode) or auto-run with a dangerous-op confirm
(Autonomous mode).

## Policy model

Two independent axes, stored per workspace (overridable per connection), with the
safest defaults:

1. **Autonomy** — `approval` (default) | `autonomous`.
   - `approval`: write tools never mutate; they return proposals the user runs.
   - `autonomous`: write tools auto-run, **except** dangerous operations
     (classified below), which always require a one-click confirm.
2. **Data exposure** — `metadata` (default) | `on_request` | `unrestricted`.
   Controls whether **tool results containing row data** (`run_select`,
   `profile_table`) are fed back into the model context. Schema/metadata tools are
   always allowed. Under `metadata`, results render to the user but the model only
   receives a summary (column names + row count), never cell values.

**Dangerous-operation classifier** (pure logic, TDD): flags `DROP`, `TRUNCATE`,
`DELETE`/`UPDATE` without a `WHERE`, `ALTER … DROP`, and statements whose
estimated affected-row count exceeds a threshold. Reuses the spirit of the Redis
console's destructive-command gate and the existing SQL preview/rollback flow.

**Danger-combo guard:** selecting `autonomous` + `unrestricted` shows a one-time
warning banner; the combination is allowed but never the default.

Secrets are never sent to the model; the redaction step strips connection
passwords / secret refs from any context assembled for the provider.

## UI

- **Chat panel** docked right of the editor/grid by default; a control switches it
  to a **dedicated full-width tab** (same component, different mount).
- Message stream with: streamed assistant text, a **collapsible tool-call trace**
  (`🔧 describe_table(users) → 12 cols`), inline **result mini-grid** with
  `[Send to editor]` / `[Run]` actions, and **inline approval cards** for write
  proposals (showing SQL + estimated impact).
- **Agent settings**: provider selection (Direct API key entry per provider, or
  CLI path/detection), model, autonomy toggle, data-exposure level. Provider
  onboarding surfaces actionable errors (not installed / not logged in / no key).

## Phasing

Decomposed into shippable sub-projects; each gets its own spec → plan →
implement → verify cycle. Mapped to the existing milestone issues.

| Phase | Deliverable | Issues |
| --- | --- | --- |
| **P0** | Spike + ADR: can local CLIs run headless with auth reuse and a usable tool-call protocol? Go/no-go for `LocalCliAdapter`. | #9, #11 |
| **P1** | `LLMProvider` port + `DirectApiAdapter` + provider settings/onboarding + chat panel + agent loop with **read/explore tools**. Ships the "ask about my DB" assistant. | #10, #12, #13 (read subset), #15, #16 |
| **P2** | Diagnostics tools + query-authoring (NL→SQL to editor, explain, optimize, fix-error). | #13 (diagnostics subset) |
| **P3** | Write tools + safety: PolicyEngine, dangerous-op classifier, approval/autonomous, preview/impact/rollback, danger-combo guard. | #14 |
| **P4** | `LocalCliAdapter` (if P0 green) + pop-out tab + data-exposure policy hardening. | #10/#11 (CLI), #15 (pop-out) |
| **P5 (v1.1)** | Docs auto-generation, Redis-specific analysis, inline Cmd+K. | new |

> P0 runs first/parallel, but **P1 builds on Direct API** so progress is never
> blocked by CLI-wrap uncertainty.

## Testing strategy

- **Pure logic (TDD, red→green):** dangerous-op classifier, policy-engine
  decisions (which tool is allowed / proposed / results withheld per policy),
  tool arg-schema validation, CLI tool-call protocol parser/encoder, neutral
  request↔provider-wire translation.
- **Integration:** each `LLMProvider` adapter (Direct API against a stub/live
  endpoint; CLI against the installed binary in the spike), `ToolRuntime` against
  a local DB (throwaway tables, mirrors existing engine integration tests).
- **Live verification (AGENTS Rule 0):** drive the running app via Playwright/CDP
  for the chat flow — ask a schema question, NL→SQL retrieval, a write proposal
  approved in Approval mode, and a dangerous-op confirm in Autonomous mode.

## Non-goals (YAGNI for v1)

Local/on-device inference; fine-tuning; multi-agent orchestration; autonomous
background jobs; cross-database federation; voice. The model is always invoked
on an explicit user message.

## Open questions / risks

- **CLI headless feasibility** — the central unknown; owned by P0. If no clean
  non-interactive tool-call channel exists, CLI support is reduced to "open a
  prepared prompt in the terminal" or dropped.
- **Per-DB diagnostics sources** — `performance_schema` / `pg_stat_statements`
  may be disabled; tools must detect and degrade.
- **Token/cost** — mitigated by lazy tool-calling + metadata-only default; surface
  a per-session token indicator.
- **Cancellation** — the loop must honor cancel mid-tool and mid-stream (reuse
  `CancelSession` for in-flight queries).
