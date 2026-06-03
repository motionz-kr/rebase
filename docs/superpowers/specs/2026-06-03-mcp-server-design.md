# MCP Server — Rebase as a Tool Gateway — Design

**Status:** approved (brainstorming) · **Milestone:** #4 · **Epic:** #33

## Goal

Let external AI clients (Claude Desktop, Codex, Cursor) use a user's database
connections through Rebase's governed tool surface over MCP — opt-in per
connection, with the same safety policies the in-app agent already enforces, and
a one-click "auto-connect" that wires the chosen client's config.

## Context (current state)

- An MCP server already exists: `engine/internal/adapters/mcp/server.go` —
  newline-delimited JSON-RPC 2.0 over **stdio**, `initialize` / `tools/list` /
  `tools/call`, exposing the agent's `Registry` (14 DB tools). Launched via
  `app-engine -mcp <profileId>` (`runMCPServer` in `engine/cmd/app-engine/main.go`).
  Today it's used internally by the local-CLI agent providers.
- **Gap:** `runMCPServer` calls `Registry.Dispatch` directly, so the
  data-exposure and secret-redaction policies (which live in
  `agent.AgentService`) are **not applied**. External exposure must close this.
- Partial scaffolding exists: a workspace-level `MCPSettings{enabled, allowedDBs}`
  + `/mcp/settings` route (`workspace_handler.go`). We move to **per-connection**
  settings instead.
- All current tools are **non-mutating**: reads/diagnostics + `propose_write`
  (which only classifies a statement and returns the proposed SQL; it never
  executes).

## Decisions

1. **Transport:** **stdio only.** The client launches `app-engine -mcp <profileId>`;
   no open network port. Reuses the existing server. (HTTP/SSE is a possible
   future slice, out of scope here.)
2. **Tools:** the existing 14, unchanged — all non-mutating.
3. **Safety:** the MCP dispatch path applies the **data-exposure policy**
   (per connection, default `metadata` = schema + row counts, no cell values)
   and **secret redaction** (connection password / secret ref), reusing the
   agent's policy logic. A connection that isn't MCP-enabled is **refused**.
4. **Per-connection settings:** add `mcpEnabled` (bool) and `mcpDataExposure`
   (`metadata` | `on_request` | `unrestricted`, default `metadata`) to the
   connection profile, persisted in the SQLite metadata DB.
5. **Onboarding:** a per-connection "Connect an AI client" panel with a
   copy-paste config snippet **and** one-click **auto-connect** that safely
   merges the entry into a detected client's config (Claude Desktop, Codex,
   Cursor).

## Architecture

### Policy-aware MCP server (engine)

- Extract the agent's result-policy logic (`sanitizeForPolicy` + secret
  `redact`) into a small shared unit in the `agent` package so both
  `AgentService` and the MCP server use the same code (DRY).
- `mcp.Server` gains a `Policy` (data-exposure + secret list). `tools/call`
  runs `Registry.Dispatch`, then applies the policy to the result before
  returning it to the client (data tools' row values withheld under
  `metadata`/`on_request`; secrets scrubbed from any text).
- `runMCPServer(profileId)`:
  1. Load the profile + its MCP settings.
  2. If `mcpEnabled` is false → print a clear error to stderr and exit non-zero
     (a disabled connection can't be served even if the command is crafted).
  3. Build the registry, construct the server with the profile's
     `mcpDataExposure` policy + secrets (`password`, `secretRef`), serve on
     stdio.

### Per-connection MCP settings (engine)

- Extend `domain.ConnectionProfile` with `McpEnabled bool` + `McpDataExposure
  string`; persist via the existing profile repository (SQLite). Default:
  disabled, `metadata`.
- HTTP: extend the profile update path (or a dedicated `POST /mcp/connection`)
  to set these. Remove/retire the unused workspace-level `MCPSettings` if it has
  no other consumer (verify first; keep if used).

### Onboarding UI (renderer + desktop main)

- A **"Connect an AI client"** panel in a connection's settings:
  - **Expose via MCP** toggle → writes `mcpEnabled`.
  - **Data exposure** selector → writes `mcpDataExposure`.
  - **Generated snippet** (read-only, copy button): the client config entry for
    `rebase-<connId>` — `command` = absolute `app-engine` path, `args` =
    `["-mcp","<profileId>","-token","mcp","-handshake","<devnull>"]`, sanitized
    `env`. The binary's absolute path comes from the main process via IPC
    (`process.resourcesPath/bin/app-engine` when packaged; dev path otherwise).
  - **Auto-connect buttons** — "Connect to Claude Desktop / Codex / Cursor",
    each enabled only when that client is detected on disk.

### Auto-connect (desktop main)

- A **client registry**: `client → { detectPath(s) per OS, format }`.
  - **Claude Desktop** — JSON, `mcpServers` object.
    macOS `~/Library/Application Support/Claude/claude_desktop_config.json`,
    Windows `%APPDATA%/Claude/claude_desktop_config.json`.
  - **Cursor** — JSON, `mcpServers` object, `~/.cursor/mcp.json`.
  - **Codex** — **TOML**, `[mcp_servers.<name>]` tables, `~/.codex/config.toml`.
- **Safe merge** (per format — JSON and TOML mergers):
  1. Read the existing config (or start from empty if absent).
  2. Write a timestamped `.bak` backup of the existing file.
  3. Set only our namespaced key (`mcpServers.rebase-<connId>` /
     `[mcp_servers.rebase-<connId>]`), preserving every other server and key.
  4. Validate the result parses, then write it.
- Re-running is **idempotent** (overwrites only our key). Undetected clients
  fall back to the copy-paste snippet.

## Security model

- stdio = **local trust boundary**: only a local process that can run the binary
  gets access — the same boundary as the user's own machine.
- `mcpEnabled` is the **opt-in gate**; disabled connections are refused.
- The **data-exposure policy** governs whether cell values leave the machine;
  default `metadata` sends none.
- `propose_write` never executes; no tool mutates data.
- **Secret redaction** scrubs the connection password / secret ref from anything
  returned to the client.
- Auto-connect only writes our namespaced key and backs up first — it never
  clobbers other MCP servers or unrelated config.
- The UI states plainly: "Exposing a connection lets local AI clients read it at
  the selected data-exposure level."

## Error handling

- Disabled connection invoked → non-zero exit + stderr message (the client shows
  the server failed to start).
- Tool dispatch error → JSON-RPC error result (existing behavior).
- Auto-connect: client not detected → button disabled, snippet shown; malformed
  existing config → abort with a clear message, original left untouched (backup
  not needed since we didn't write); write failure → restore from backup.

## Testing strategy

- **Pure logic (TDD):**
  - MCP dispatch policy application — under `metadata`, a `run_select` result is
    returned **without** cell values (carries column names + row count); under
    `unrestricted`, values pass through.
  - `runMCPServer` refusal when `mcpEnabled` is false (testable via the policy
    decision function).
  - The config-snippet generator (pure: profile + binary path → JSON entry).
  - JSON safe-merge and TOML safe-merge — adds our key, preserves other keys, is
    idempotent, produces valid output.
- **Integration:** `tools/list` + `tools/call` against a live DB with a policy
  (extend `server_test.go`).
- **Live (AGENTS Rule 0):** enable a connection, auto-connect to a real client
  (or feed the snippet to `claude --mcp-config`), confirm the external client
  lists + calls the tools and that `metadata` withholds cell values; verify the
  client's config file gained only our entry (others intact) + a backup exists.

## Phasing (sub-projects → issues)

| Phase | Deliverable |
| --- | --- |
| **P1** | Policy-aware MCP server (apply data-exposure + redaction in dispatch; refuse if disabled) + per-connection MCP settings on the profile (fields, repo, handler). TDD. |
| **P2** | Onboarding UI: "Connect an AI client" panel — expose toggle, data-exposure selector, copy-paste snippet (main IPC for the binary path). Manual path works end-to-end. |
| **P3** | Auto-connect: client detection + JSON/TOML safe mergers + backups, for Claude Desktop / Codex / Cursor. TDD on the mergers. |
| **P4** | Docs (`docs/mcp-server.md`) + live verification with a real external client. |

## Non-goals (YAGNI for v1)

HTTP/SSE transport; remote access / auth tokens; exposing write-executing tools;
auto-connect for clients beyond the three above; editing/removing entries we
didn't create; multi-connection bundles in one server process.

## Open questions / risks

- **Codex TOML merge** needs a Go/Node TOML round-trip that preserves unrelated
  tables; pick a well-behaved library or a minimal targeted merge.
- **Client config paths** vary by version/OS; detection must be defensive
  (missing dir = "not detected", not an error).
- The bundled `app-engine` path must be **stable and absolute** in the generated
  config; document that moving the app breaks existing client entries (re-run
  auto-connect to fix).
