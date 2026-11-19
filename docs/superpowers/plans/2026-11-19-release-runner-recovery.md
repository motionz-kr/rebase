# Restore macOS release builds

## Evidence and scope

The user authorized the CTE fix production release. PRs #228 and #229 passed CI
and CodeQL and were merged; `v0.39.2` contains the fix. Release run 44435475609
cancelled the macOS job before execution with:
`The configuration 'macos-14-arm64-us-default' is not supported`.
The Windows job continues independently.

GitHub retired macOS 14 hosted runners on 2026-11-02. Use the supported pinned
`macos-15` arm64 runner in both mac-only and both-platform matrices.
Source: https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement/

## Plan and verification

1. Change only the two release matrix runner labels; retain darwin/arm64,
   signing, packaging, tag checkout and Windows configuration.
2. Execute the workflow's actual matrix resolver for push trailer and manual
   platform selections; validate JSON, platforms and architectures.
3. Merge the workflow fix after PR checks. Dispatch a mac-only rebuild for the
   existing `v0.39.2` tag; do not create another app version.
4. Verify macOS build/smoke/signing/publication, Windows publication, and both
   updater manifests for `0.39.2`.

This workflow-only recovery does not change app runtime behavior. The hosted
release build is the verification of the changed path; existing CTE Electron
E2E results remain applicable. Reuse the existing worktree, branch
`feat/release-macos15`; no new worktree or dependency installation.
