<!--
PR title MUST be a Conventional Commit, e.g.:
  feat(agent): add OpenAI provider
  fix(grid): keep NULL cells editable
A bot checks the title and comments if it's not valid.
-->

## What & why

<!-- What does this change and why? Link issues: "Closes #123". -->

## How

<!-- Brief notes on the approach / key decisions. -->

## Checklist

- [ ] PR title follows [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] Tests added/updated for new logic
- [ ] `pnpm --filter renderer test && pnpm --filter renderer lint` pass
- [ ] `pnpm --filter desktop test` passes
- [ ] `go build ./engine/...` (and `go test ./engine/...` where applicable) pass
- [ ] Docs updated if behavior/usage changed

## Screenshots / notes

<!-- For UI changes, add before/after screenshots. -->
