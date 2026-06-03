# Auto-Update — operating notes

In-app auto-update is built on `electron-updater`. On launch the app checks the
GitHub Releases feed of this (public) repo; when a newer version exists a
top-right **업데이트** button appears, and clicking it opens a modal that drives
the update.

## Releasing

1. Bump `version` in `apps/desktop/package.json`.
2. Commit, then push a tag:

   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```

3. CI (`.github/workflows/release.yml`) builds **macOS (arm64)** and **Windows
   (x64)** — cross-building the Go engine per OS — and runs
   `electron-builder --publish always`, which uploads the installers **and** the
   update metadata (`latest.yml` / `latest-mac.yml`) to a GitHub Release in this
   repo (`motionz-kr/rebase`). Clients read that feed directly.

Because the repo is **public**, the workflow's built-in `secrets.GITHUB_TOKEN`
already has the permission to create the release — **no extra PAT/secret is
required**.

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
