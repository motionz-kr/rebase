# Contributing to Rebase

Thanks for your interest in contributing! Rebase is a desktop database manager
(Electron + React renderer + a Go engine). This guide gets you from clone to PR.

## Project layout

```
apps/desktop    Electron main + preload (TypeScript)
apps/renderer   React 19 + Vite UI (TypeScript)
engine          Go 1.25 local engine (Clean Architecture)
docs            ADRs, specs, and implementation plans
```

## Prerequisites

- **Node 20+** and **pnpm 8** (`corepack enable` or `npm i -g pnpm@8`)
- **Go 1.25+** (matches `go.mod`)
- For integration/E2E tests: local **MySQL** and **PostgreSQL** (see `AGENTS.md`)

## Setup

```bash
pnpm install
pnpm build:engine        # builds the Go engine into apps/desktop/bin
pnpm dev                 # runs the renderer (Vite) + Electron
```

## Tests & checks (run before opening a PR)

```bash
pnpm --filter renderer test      # renderer unit tests (vitest)
pnpm --filter renderer lint      # eslint (must be 0 errors)
pnpm --filter renderer build     # type-check + bundle
pnpm --filter desktop test       # main-process unit tests
pnpm --filter desktop build      # tsc
go build ./engine/...            # engine compiles
go test ./engine/...             # engine tests (some need live DBs — see AGENTS.md)
```

CI runs the same fast checks on every PR. Integration and E2E suites need live
databases and run locally.

## Commit & PR conventions

We use **[Conventional Commits](https://www.conventionalcommits.org/)**. This is
**required** — releases and version bumps are generated automatically from commit
history by [release-please], and the PR title is linted against this format.

| Type | Effect | Example |
| --- | --- | --- |
| `feat:` | minor release | `feat(agent): add OpenAI provider` |
| `fix:` | patch release | `fix(grid): keep NULL cells editable` |
| `feat!:` / `BREAKING CHANGE:` | major release | `feat!: drop legacy config` |
| `docs:` `chore:` `ci:` `refactor:` `test:` `style:` | no release | `docs: clarify setup` |

Scope (in parentheses) is optional but encouraged: `engine`, `renderer`,
`desktop`, `agent`, `redis`, `ci`, etc.

**PR flow**

1. Branch from `main` (e.g. `feat/my-thing`, `fix/that-bug`).
2. Keep PRs focused; write tests for new logic (TDD encouraged).
3. Ensure the checks above pass.
4. Open a PR — the **title must be a valid Conventional Commit** (a bot checks it
   and comments if not). Fill in the PR template.
5. A maintainer reviews; CI must be green to merge.

## Releases

You don't tag or bump versions by hand. When PRs land on `main`, [release-please]
maintains a "Release PR"; merging it cuts the version, tag, GitHub Release, and
the macOS/Windows installers. See `docs/auto-update.md`.

## Code of Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By
participating you agree to uphold it.

[release-please]: https://github.com/googleapis/release-please
