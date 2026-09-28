# SELECT* read-only classification fix

## Goal

Treat `SELECT* FROM ...` as a read-only query in the engine policy gate, so a
missing space before `*` does not incorrectly trigger the write permission
prompt.

## Scope

- Update the domain SQL classifier's leading-keyword recognition to stop at
  SQL punctuation while keeping identifier continuations attached to a token.
- Add a regression case for the reported query shape.
- Preserve conservative handling of unknown verbs and write statements.

## Validation

- [x] Run the Go domain tests, including the regression case and the
  SELECT-like identifier guard.
- [x] Build the engine, renderer, and desktop main process.
- [x] In Playwright/Electron with an isolated SQLite profile and temporary DB,
  verify `select* from AlimtalkTemplate where id = 7888` returns its row without
  asking to enable write mode.

The full `go test ./...` command was also attempted; unrelated packages hit
sandbox restrictions on Keychain access and local network binding.
