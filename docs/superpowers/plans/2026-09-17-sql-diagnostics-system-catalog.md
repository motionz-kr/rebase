# SQL diagnostics system catalog handling

## Goal

Prevent the query editor's lightweight schema diagnostics from reporting valid
database system catalogs as missing user tables, especially for the default
schema-list query shown when opening a MySQL query tab.

## Approach

1. Recognize common system catalog namespaces and SQLite catalog tables in the
   diagnostics resolver.
2. Keep syntax and other diagnostics active; suppress only name-resolution
   errors for recognized catalog references.
3. Add unit coverage for MySQL, PostgreSQL, SQL Server, and SQLite catalog
   queries, plus an Electron regression for the default MySQL query.

## Verification

- Renderer diagnostics unit tests.
- Desktop Playwright regression with an isolated MySQL profile when available.
- Renderer and desktop builds.
