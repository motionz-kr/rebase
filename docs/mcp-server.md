# MCP Server — expose Rebase to external AI clients

Rebase can act as an [MCP](https://modelcontextprotocol.io) server, letting
external AI clients (Claude Desktop, Codex, Cursor) use a connection's database
tools — under the same access-scope and read-only safety policy as the in-app
agent.

## Quick start (60 seconds)

1. In Rebase, open the **MCP** tab on each SQL connection you want to expose and
   toggle **이 연결을 외부 AI 클라이언트에 노출** on.
2. From any enabled connection, click **Claude Desktop에 연결** (or **Codex** /
   **Cursor**) once. Rebase installs one shared server entry and backs up the
   existing client config first.
3. Restart the AI client to load the new MCP server entry. Ask it to list the
   available Rebase connections, then use the connection you want.

> Prefer manual setup? Copy the JSON snippet shown in the panel into the client's
> MCP config. If the client already has profile-specific Rebase entries, remove
> those manually; Auto-connect migrates them automatically.

## Example prompts (to your AI client)

Once connected, ask the client things like:

- "List the Rebase connections I can use and inspect the analytics database."
- "What tables are in the database, and how are they related?"
- "Describe the `orders` table — columns, types, indexes."
- "Find slow queries and tell me which indexes are missing."
- "Are there any unused or duplicate indexes I can drop?"
- "Update the stale `orders` rows." *(creates an approval request when writes
  are enabled for that connection — see below)*

The client calls Rebase's tools (`list_tables`, `describe_table`, `run_select`,
`explain_query`, …) so its answers are grounded in your **actual** schema, not
guesses.

The shared server also provides `discover_local_databases`,
`list_saved_connection_profiles`, and `propose_connection_profile`. Ask the AI
to find a local database and suggest a new or updated profile. The proposal is
only a request: it appears in **MCP 활동**, where you can compare the proposed
fields, enter the password in Rebase, test the connection, and save it. MCP
cannot provide an arbitrary host/port, credentials, or change the target
profile's MCP exposure, write mode, or database/schema/table scope. A new profile
starts with MCP exposure off and writes disabled.

## Governance in action

MCP returns tool results unchanged so the connected client can use actual rows,
diagnostic values, and complete `EXPLAIN` plans. For a table
`demo_users(name, email)`, `run_select` returns the actual values. Credentials
are still redacted before a response leaves the server.

Writes are disabled by default. When **승인 후 실행** is selected for an
individual connection, `propose_write` stores the exact SQL as a pending request;
it still does not execute it. Open **MCP 활동**, review the SQL and risk reasons,
then click **승인 후 실행**. Rebase executes that stored statement exactly once
and reports the outcome through `write_proposal_status`. **거부** rejects the
request without touching the database.

## Scope and activity history

Each connection keeps its own engine-enforced **접근 허용 범위** and write
policy. The shared MCP server can select only profiles whose **이 연결을 외부
AI 클라이언트에 노출** setting is enabled. Every database tool call must pass
the selected connection's `connectionId` returned by `list_connections`.

The MCP tab also has an engine-enforced **접근 허용 범위** section:

- **허용 데이터베이스** — exact database names. For MySQL this is also the
  schema namespace used by the adapter.
- **허용 스키마** — exact schema names (`public`, `dbo`, etc.).
- **허용 테이블** — exact table names, optionally schema-qualified such as
  `public.orders`.

Each value is entered one per line. An empty list preserves the legacy
unrestricted behavior for that dimension. These lists are persisted with each
connection profile and enforced in the engine for metadata tools,
`run_select`, and `explain_query`; the Schema tab's hidden-table setting only
changes local display and is not a security control. When an allowlist is
active, an ambiguous table reference is rejected conservatively.

The MCP activity page shows shared-server handshakes, tool calls, errors, and
pending write approvals. Each tool call is recorded against its selected
connection profile. The external-server section shows test/call activity.
Tool-call activity includes the SQL actually
sent to the connector (including generated `EXPLAIN` and diagnostic queries)
and elapsed time; expand an event to inspect the exact query.
Registered connection secrets are replaced with `[redacted]` before SQL is
stored; passwords, headers, and environment variables are not stored in this
history. “Connected” means the
client configuration is saved; the latest activity indicates whether a real
session or call has occurred.

## Enable a connection

1. Edit a supported SQL connection (the pencil icon).
2. In **AI 클라이언트 연결 (MCP)**, turn on **이 연결을 외부 AI 클라이언트에 노출**.
A connection that isn't enabled is **refused** even if a client is configured to
launch it. Once enabled, read-only MCP tools return their complete results,
including row values and `EXPLAIN` plans.
3. Choose the connection's **외부 AI 쓰기 실행** policy:
   - **사용 안 함 (읽기 전용)** — `propose_write` only returns a safety assessment.
   - **승인 후 실행** — each write becomes a pending request in **MCP 활동** and
     requires an explicit Rebase approval.
   - **완전 허용 (자동 실행)** — exposes `execute_write`, which executes write
     and DDL statements immediately. The connection's read-only flag and MCP
     database/schema/table scope still apply.

## Connect a client

The panel shows a ready-to-paste config snippet and one-click buttons:

- **Auto-connect** — click **Claude Desktop / Codex / Cursor** (enabled when the
  client is detected). Rebase adds the single `rebase-databases` entry,
  **backs up the existing file first**, preserves unrelated entries, and removes
  older Rebase entries that were bound to individual profiles.
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

Restart the client after installing or changing the MCP server entry. Existing
MCP processes pick up saved profiles and permission changes on the next tool
call, including when the client caches its tool list. The entry runs the bundled
engine in unified MCP stdio mode:
`app-engine -mcp all`. The process discovers MCP-enabled SQL profiles from
Rebase's local profile store. Stdio uses local process pipes and does not use a
bearer token or the desktop HTTP handshake file; the old literal `-token mcp`
argument was not an authentication credential.

## Tools exposed

The shared server exposes discovery and profile proposal tools alongside the
database tools. Its SQL tool catalog stays stable for clients that cache
`tools/list`; each call checks the selected profile's latest policy. The
read/diagnostic tools include:
`list_connections`, `list_tables`,
`describe_table`, `get_table_ddl`, `list_indexes`, `list_foreign_keys`,
`find_column`, `profile_table`, `table_stats`, `run_select`, `explain_query`,
`find_duplicate_indexes`, `slow_queries`, `find_unused_indexes`,
`propose_write`, `write_proposal_status`, and `execute_write`. The catalog keeps
all SQL policy tools available for clients that cache it. `execute_write` is
rejected unless the selected profile currently has `full_access` enabled and is
not read-only. `write_proposal_status` only returns requests belonging to the
selected profile and approval mode.
`discover_local_databases` checks known loopback ports and locally published
Docker ports. Remote Docker contexts are skipped. `propose_connection_profile`
accepts only a returned candidate ID plus non-secret profile fields;
`list_saved_connection_profiles` omits credentials and secret references.
Every SQL database tool requires the `connectionId` returned by `list_connections`;
database tools may also accept a `database` argument to select another exact
allowed database within that profile. A policy tool advertised for one profile
can return “not enabled for selected connection” on another.
`propose_write` remains proposal-only unless that profile uses approval mode and
the user approves the request in the Rebase activity view.

## Security model

- **stdio only** — no network port; the client launches the binary locally. The
  trust boundary is your machine.
- **One client entry, opt-in per connection** — one local MCP process lists only
  profiles individually enabled for MCP.
- **Reviewed profile changes** — MCP can request a connection profile change,
  but only Rebase UI can test and save it. Credentials stay in the OS Keychain
  and profile permissions stay under the user's control.
- **Write policy per connection** — writes remain disabled unless the profile is
  explicitly set to approval mode; profile-level read-only still overrides it.
- **Explicit approval** — the approval UI executes the stored SQL, not a newly
  generated or edited statement.
- **Full read results** — row values and diagnostic output are returned to the
  connected local client so it can answer database questions accurately.
- **Secret redaction** strips the connection password / secret ref from anything
  returned.
- **Auto-connect** writes the `rebase-databases` key, backs up the existing
  config, preserves unrelated servers, and removes Rebase's old profile-bound
  entries.

## Notes

- MySQL/PostgreSQL profiles using **AWS SSM (EC2 경유)** work with the same MCP
  config. The local MCP engine starts its own tunnel lazily from saved AWS
  profile/region/EC2 settings; Electron does not need to be running for reads.
  AWS CLI and Session Manager plugin must be installed, and AWS authentication
  must be available to the local MCP process. Logs never mix with JSON-RPC stdout.
  Saved custom SSM documents and document-owned destinations also apply, including
  documents accepting only `localPortNumber`. Each engine allocates its own port.
  See [SSM connections](ssm-connections.md). Existing UI approval requirements
  still apply to approval-mode writes.

- Codex's TOML config is round-tripped on merge (data preserved; comments and
  ordering are not). Back up manually first if you keep hand-formatted comments.
- The config embeds the **absolute** path to the bundled engine. If you move the
  app, re-run auto-connect to update existing client entries.
