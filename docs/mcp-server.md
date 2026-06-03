# MCP Server — expose Rebase to external AI clients

Rebase can act as an [MCP](https://modelcontextprotocol.io) server, letting
external AI clients (Claude Desktop, Codex, Cursor) use a connection's database
tools — under the same safety policy as the in-app agent.

## Enable a connection

1. Edit a **MySQL or PostgreSQL** connection (the pencil icon).
2. In **AI 클라이언트 연결 (MCP)**, turn on **이 연결을 외부 AI 클라이언트에 노출**.
3. Pick a **데이터 노출** level:
   - **메타데이터만 (default):** schema + row counts only — cell values are never
     sent to the client.
   - **요청 시 / 전체:** progressively send row values.

A connection that isn't enabled is **refused** even if a client is configured to
launch it.

## Connect a client

The panel shows a ready-to-paste config snippet and one-click buttons:

- **Auto-connect** — click **Claude Desktop / Codex / Cursor** (enabled when the
  client is detected). Rebase merges its server entry into that client's config,
  **backing up the existing file first** and preserving every other entry.
- **Copy snippet** — paste the JSON into the client's MCP config manually.

Config locations:

| Client | File | Format |
| --- | --- | --- |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) · `%APPDATA%\Claude\claude_desktop_config.json` (Windows) | JSON |
| Cursor | `~/.cursor/mcp.json` | JSON |
| Codex | `~/.codex/config.toml` | TOML |

Restart the client after connecting. The entry runs the bundled engine in MCP
mode: `app-engine -mcp <profileId> -token mcp -handshake /dev/null`.

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
- **Data-exposure policy** decides whether cell values leave the machine
  (default: none).
- **Secret redaction** strips the connection password / secret ref from anything
  returned.
- **Auto-connect** writes only the `rebase-<connId>` key, backs up the existing
  config, and never clobbers other servers.

## Notes

- Codex's TOML config is round-tripped on merge (data preserved; comments and
  ordering are not). Back up manually first if you keep hand-formatted comments.
- The config embeds the **absolute** path to the bundled engine. If you move the
  app, re-run auto-connect to update existing client entries.
