# SSH bastion connections

Add key-file SSH forwarding for MySQL/PostgreSQL alongside direct and SSM routing.
The engine owns SSH authentication, verified host keys, loopback listeners and cleanup.
Store only bastion host/port/user and user-selected identity/known_hosts paths, never key contents.
Use golang.org/x/crypto/ssh already present in go.mod; no external SSH process or shell.
Initial scope: unencrypted PEM/OpenSSH identity files; encrypted keys return a clear error.
Host verification uses an existing known_hosts file (default ~/.ssh/known_hosts); unknown/changed hosts fail closed.

1. RED: domain route validation, form conversion, resolver failure and persistence tests.
2. GREEN: SSH adapter and routing composition, additive v20 metadata migration.
3. Connect settings UI and native file chooser, preserve existing SSM/direct behavior.
4. Adapter integration against a disposable SSH server, lifecycle/cancellation/host-key tests.
5. Build/typecheck/lint and isolated Electron E2E: test/save/edit/query/cleanup and failure paths.
6. Update architecture/security/connection docs. No operational DB access.

## Validation completed

- Renderer route test RED observed for unsupported SSH route, then 4 tests GREEN.
- SSH domain regression test was also run with the SSH validation branch removed:
  it failed with `unsupported connection mode`, then passed against the new route.
- Connection-test error display test RED observed for the JSON envelope, then GREEN.
- `go test ./engine/...`: passed, including migration preservation and routing contracts.
- `go test -race ./engine/internal/adapters/ssh`: passed; real SSH authentication,
  RSA PEM/OpenSSH formats, encrypted/invalid-key errors, unknown/changed host keys,
  concurrent startup/reuse, remote disconnect/reconnect, cancellation and cleanup.
- Application endpoint tests passed with the race detector.
- Engine, renderer and desktop builds/type checks passed.
- Renderer tests: 62 files / 459 passed. Desktop tests: 6 files / 32 passed.
- Renderer lint: no errors, 3 existing hook dependency warnings. gofmt and git diff checks passed.
- Electron E2E: 7 passed across SSH, selected SSM failures and smoke specs.
  SSH uses a real, disposable SSH server and isolated local MySQL/PostgreSQL containers;
  test/save/edit/SELECT results were observed in the built app and screenshots inspected.
  Expanded SSH specs also passed (3 tests) with independent unified MCP engines:
  MySQL/PostgreSQL `run_select` returned results through SSH, and `list_connections`
  did not expose private key file references.
  Native file chooser response is supplied by the isolated E2E app; the picker IPC
  and returned file references are exercised without selecting personal files.
- Temporary Go 1.25.7 was downloaded with user approval and SHA256 verified against
  official go.dev metadata; no system installation or global PATH changes.
- AWS bastion/RDS, Windows runtime and release packaging were not exercised.
- Prettier executable is absent; no formatter was installed. Existing TS style retained.
- No operational DB was accessed and no Jira mutation was performed.
  Implementation validation preceded commit/push/merge authorization.
- Disposable DB containers and temporary Go toolchain/cache removed after verification.

## Authorized delivery

The user authorized a feature PR, merge and macOS release after implementation
validation. Use the existing Release Please PR for version 0.38.0 and a
`Release-Platform: mac` trailer on its merge commit. Require feature PR CI and
CodeQL, inspect the updated release diff, and verify published macOS artifacts.
The release also includes the already merged database discovery feature.
