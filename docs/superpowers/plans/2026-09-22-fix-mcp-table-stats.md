# MCP table_stats driver-qualified table fix

## Goal

Make the `table_stats` MCP tool accept the same unqualified and schema/database-qualified table references as the other MCP metadata tools, and generate valid statistics SQL for MySQL, PostgreSQL, SQLite, and SQL Server.

## Scope

- Extract a pure `tableStatsQuery` builder in the agent layer.
- Parse the already-authorized MCP table reference into database/schema/table parts.
- Use the parsed parts in each driver-specific catalog query.
- Add unit tests for qualified references and all supported SQL drivers.
- Run agent/MCP tests and perform a real stdio MCP call where the local environment permits it.

## Safety

- Keep the tool read-only and retain existing MCP scope authorization.
- Continue escaping values as SQL literals; no raw table identifier is interpolated without driver quoting.
- Do not touch user or production database data.
