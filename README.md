# Rebase

A fast, local-first desktop database manager (MySQL · PostgreSQL · Redis) built on
Electron + React with a Go query engine. Browse schemas, run queries, edit data
inline, and manage objects — all from one keyboard-friendly UI.

## Stack

- **Electron 28** desktop shell (`apps/desktop`) — main/preload, spawns the engine
- **React 19 + Vite** renderer (`apps/renderer`) — UI, Monaco SQL editor
- **Go 1.25** local engine (`engine/`) — Clean Architecture (domain / application /
  ports / adapters / transport), streams query results over a local HTTP bridge
- Profiles in SQLite (`~/.antigravity/metadata.db`), secrets in the OS keychain

## Features

- Connections: create / edit / delete; MySQL, PostgreSQL, Redis
- Schema explorer — tables, views, indexes, foreign keys; create/alter table, DDL view
- SQL editor — autocomplete, format, EXPLAIN, multi-statement scripts, history
- Result grid — sort, filter, export (CSV/JSON), keyboard navigation, **pin columns**,
  one-click "recent 500 rows"
- Editable results — inline cell edit, add/delete rows, transactional save,
  **⌘/Ctrl+Enter to submit** (DataGrip-style); execution status bar
- CSV import, FK navigation

## Develop

```bash
pnpm install
pnpm dev            # vite renderer + electron (spawns the Go engine)
```

Toolchain: Node (nvm), pnpm, Go at `/Users/smlee/sdk/go/bin`.

## Test

```bash
pnpm --filter renderer test     # renderer unit tests (vitest)
cd engine && go test ./...      # engine unit + integration (needs local DBs)
pnpm --filter desktop test:e2e  # Playwright Electron E2E (skips if no local MySQL)
```

## Build (production)

```bash
pnpm build                                   # engine + renderer + desktop
cd apps/desktop && CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac
# → apps/desktop/dist/installers/Rebase-*.dmg
```

Unsigned builds run locally; for distribution to other Macs, sign with a Developer
ID certificate and notarize (or have recipients clear quarantine: `xattr -cr Rebase.app`).

See `AGENTS.md` and `docs/` for architecture and contribution rules.
