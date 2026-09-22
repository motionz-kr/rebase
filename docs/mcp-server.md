# MCP Server — expose Rebase to external AI clients

Rebase can act as an [MCP](https://modelcontextprotocol.io) server, letting
external AI clients (Claude Desktop, Codex, Cursor) use a connection's database
tools — under the same access-scope and read-only safety policy as the in-app
agent.

## Quick start (60 seconds)

1. In Rebase, click the **pencil** on a MySQL/PostgreSQL connection.
2. Open **AI 클라이언트 연결 (MCP)** and toggle **이 연결을 외부 AI 클라이언트에 노출** on.
3. Click **Claude Desktop에 연결** (or **Codex** / **Cursor**). Rebase writes the
   server entry into that client's config (backing up the old one first).
4. **Restart the AI client.** Done — ask it about your database.

> Prefer manual setup? Copy the JSON snippet shown in the panel into the client's
> MCP config instead of using the buttons.

## Example prompts (to your AI client)

Once connected, ask the client things like:

- "What tables are in the database, and how are they related?"
- "Describe the `orders` table — columns, types, indexes."
- "Find slow queries and tell me which indexes are missing."
- "Are there any unused or duplicate indexes I can drop?"
- "Write the SQL to add a `status` column to `orders`." *(returns SQL only — see
  below)*

The client calls Rebase's tools (`list_tables`, `describe_table`, `run_select`,
`explain_query`, …) so its answers are grounded in your **actual** schema, not
guesses.

## Governance in action

MCP returns tool results unchanged so the connected client can use actual rows,
diagnostic values, and complete `EXPLAIN` plans. For a table
`demo_users(name, email)`, `run_select` returns the actual values. Credentials
are still redacted before a response leaves the server.

Writes are never executed — `propose_write` only returns the SQL for you to run
(and approve) inside Rebase.

## Scope and activity history

The MCP tab also has an engine-enforced **접근 허용 범위** section:

- **허용 데이터베이스** — exact database names. For MySQL this is also the
  schema namespace used by the adapter.
- **허용 스키마** — exact schema names (`public`, `dbo`, etc.).
- **허용 테이블** — exact table names, optionally schema-qualified such as
  `public.orders`.

Each value is entered one per line. An empty list preserves the legacy
unrestricted behavior for that dimension. These lists are persisted with the
connection profile and enforced in the engine for metadata tools,
`run_select`, and `explain_query`; the Schema tab's hidden-table setting only
changes local display and is not a security control. When an allowlist is
active, an ambiguous table reference is rejected conservatively.

The same MCP tab shows recent inbound handshakes, sessions, tool calls, and
errors for that profile. The external-server section shows test/call activity.
Only event metadata (direction, event, tool name, status, duration, timestamp,
and a safe error summary) is stored; passwords, headers, environment
variables, and raw SQL are not stored in this history. “Connected” means the
client configuration is saved; the latest activity indicates whether a real
session or call has occurred.

## Enable a connection

1. Edit a **MySQL or PostgreSQL** connection (the pencil icon).
2. In **AI 클라이언트 연결 (MCP)**, turn on **이 연결을 외부 AI 클라이언트에 노출**.
A connection that isn't enabled is **refused** even if a client is configured to
launch it. Once enabled, read-only MCP tools return their complete results,
including row values and `EXPLAIN` plans.

## Connect a client

The panel shows a ready-to-paste config snippet and one-click buttons:

- **Auto-connect** — click **Claude Desktop / Codex / Cursor** (enabled when the
  client is detected). Rebase merges its server entry into that client's config,
  **backing up the existing file first** and preserving every other entry.
- **Copy snippet** — paste the JSON into the client's MCP config manually.

Auto-connect reports that the configuration was saved; it does not claim that
the client has already completed a handshake. Restart the client, then use the
recent activity list to confirm a `session_started` event.

Config locations:

| Client | File | Format |
| --- | --- | --- |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) · `%APPDATA%\Claude\claude_desktop_config.json` (Windows) | JSON |
| Cursor | `~/.cursor/mcp.json` | JSON |
| Codex | `~/.codex/config.toml` | TOML |

Restart the client after connecting. The entry runs the bundled engine in MCP
stdio mode: `app-engine -mcp <profileId> -token mcp`. MCP stdio does not use
the desktop HTTP handshake file.

## Tools exposed

The same 14 read/diagnostic tools the agent uses: `list_tables`,
`describe_table`, `get_table_ddl`, `list_indexes`, `list_foreign_keys`,
`find_column`, `profile_table`, `table_stats`, `run_select`, `explain_query`,
`find_duplicate_indexes`, `slow_queries`, `find_unused_indexes`, and
`propose_write` (which only **classifies** a write and returns the SQL — it never
executes). No tool mutates data.

## Security model

- **stdio only** — no network port; the client launches the binary locally. The
  trust boundary is your machine.
- **Opt-in per connection** — only enabled connections can be served.
- **Full read results** — row values and diagnostic output are returned to the
  connected local client so it can answer database questions accurately.
- **Secret redaction** strips the connection password / secret ref from anything
  returned.
- **Auto-connect** writes only the `rebase-<connId>` key, backs up the existing
  config, and never clobbers other servers.

## Notes

- Codex's TOML config is round-tripped on merge (data preserved; comments and
  ordering are not). Back up manually first if you keep hand-formatted comments.
- The config embeds the **absolute** path to the bundled engine. If you move the
  app, re-run auto-connect to update existing client entries.
