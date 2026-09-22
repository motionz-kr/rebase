# MCP activity page

## Goal

Make MCP activity discoverable without opening a connection settings modal. Add a persistent bottom status-bar entry and a full-screen MCP activity page that shows recent inbound/outbound sessions, tool calls, status, duration, target, and safe error summaries.

## Scope

- Add a renderer-only `McpActivityPage` using the existing `mcpActivityList` IPC API.
- Add filters for status, direction, profile/server target, and tool/event text.
- Add summary cards and expandable event details while preserving the existing metadata-only audit boundary.
- Add a bottom-bar entry with a lightweight recent-activity/failure indicator.
- Add “전체 활동 보기” entry points in the existing MCP panels.
- Keep the existing per-connection/server recent activity previews as compact context.

## Safety

- Do not add raw SQL, arguments, credentials, headers, or environment variables to the activity UI; the backend intentionally does not persist them.
- No backend or database schema changes are needed.
- Verify with renderer tests/build and a real Electron interaction when the local environment permits it.
