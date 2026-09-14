# macOS Release Recovery

## Goal

Restore a reproducible macOS arm64 release path and verify that the packaged
Electron app can launch with its bundled Go engine before publishing another
release.

## Scope

- Keep the existing release-please and Windows release flow unchanged.
- Isolate and harden the macOS package step, including DMG cleanup/retry.
- Preserve the macOS zip/app output even when DMG creation is flaky where the
  workflow can safely do so.
- Add focused tests or validation for any extracted shell/configuration logic.
- Install/use the repository-supported Go 1.25.7 toolchain locally when
  available, build `apps/desktop/bin/app-engine`, and run the relevant desktop
  smoke/E2E checks.

## Constraints

- Do not modify production databases or user profile stores.
- Do not publish or rerun a GitHub release until the workflow change is
  reviewed and validated locally as far as the host allows.
- Do not change the macOS self-update policy: unsigned macOS builds remain
  download-page based unless signing/notarization is confirmed healthy.

## Validation

- renderer unit tests, lint, and build
- desktop unit tests and build
- Go `go test ./...` and engine build with Go 1.25.7
- packaged macOS-compatible smoke checks where supported by the host
- review workflow YAML and confirm the release asset matrix/paths
