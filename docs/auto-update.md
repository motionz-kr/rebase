# Auto-Update — operating notes

In-app auto-update is built on `electron-updater`. On launch the app checks the
GitHub Releases feed of this (public) repo; when a newer version exists a
top-right **업데이트** button appears, and clicking it opens a modal that drives
the update.

## Releasing (automatic, content-driven)

Releases are driven by [release-please] from the conventional-commit history —
**you never bump the version or tag by hand**.

1. Merge feature PRs to `main` using conventional-commit messages
   (`feat:` → minor, `fix:` → patch, `feat!:` / `BREAKING CHANGE` → major).
2. `release-please` (in `.github/workflows/release.yml`) opens/updates a
   **Release PR** titled like `chore(main): release rebase 0.2.0`, containing the
   version bump (`apps/desktop/package.json`) + `CHANGELOG.md`.
3. **Merge that Release PR.** release-please creates the `vX.Y.Z` tag + GitHub
   Release, and the same workflow run then builds **macOS (arm64)** and
   **Windows (x64)** (cross-building the Go engine per OS) and
   `electron-builder --publish always` attaches the installers + update metadata
   (`latest.yml` / `latest-mac.yml`) to that Release.

So "merge the Release PR" **is** the release action. Because the repo is
**public**, the built-in `secrets.GITHUB_TOKEN` can create the release and
publish assets — **no extra PAT/secret is required**.

Config: `release-please-config.json` + `.release-please-manifest.json`
(tracks `apps/desktop` with `include-component-in-tag: false`, so tags are
`vX.Y.Z`).

[release-please]: https://github.com/googleapis/release-please

### Notes for a clean release feed

- release-please publishes the Release immediately; the installers appear a few
  minutes later once the build job finishes. Brief window where the Release has
  notes but no binaries yet.
- Manual fallback: `workflow_dispatch` on the Release workflow re-runs
  release-please (it only creates a release if there are releasable commits).

## Platform behavior

- **Windows:** true in-app self-update (NSIS). Unsigned builds trigger a
  SmartScreen warning until a Windows code-signing certificate is added.
- **macOS (unsigned):** Squirrel.Mac rejects unsigned updates, so the app
  **cannot self-install**. The **업데이트** button instead opens the Releases
  download page so the user grabs the new `.dmg`.

  To enable true macOS self-update later:
  1. Obtain an Apple Developer ID Application certificate.
  2. Add the signing secrets to CI and enable notarization (drop
     `CSC_IDENTITY_AUTO_DISCOVERY=false`).
  3. Set `MAC_SELF_UPDATE = true` in
     `apps/desktop/src/main/updatePolicy.ts`.

## How it works (code map)

- `apps/desktop/src/main/updatePolicy.ts` — pure `resolveUpdateAction()` gate +
  `MAC_SELF_UPDATE` flag + `RELEASES_PAGE_URL`.
- `apps/desktop/src/main/updateEvents.ts` — pure mapping of electron-updater
  events to the neutral `UpdateStatus`.
- `apps/desktop/src/main/updateService.ts` — wraps `autoUpdater`
  (`autoDownload=false`), forwards `update-status` to the renderer, and routes
  download vs. open-page per the policy gate.
- IPC: `update-check` / `update-download` / `update-install` (+ a dev-only
  `update-simulate` for UI testing), `update-status` event stream.
- `apps/renderer/src/lib/updateStatus.ts` — pure reducer (event → UI phase).
- `apps/renderer/src/components/UpdateButton.tsx` — top-right button + modal.

## Dev / testing

`electron-updater` only runs in a packaged app, so in dev the check is a no-op.
The renderer UI is verified by injecting simulated events through the dev-only
`window.electronAPI.updateSimulate(status)` hook (guarded by `!app.isPackaged`).
Real download/install is verified post-release on Windows; macOS true
self-update stays disabled until signing.
