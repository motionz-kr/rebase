# Auto-Update — Design

**Status:** approved (brainstorming) · **Milestone:** #3 — Auto-Update

## Goal

When a user launches an already-installed Rebase build and a newer version is
available, a top-right **Update** button appears; clicking it opens a modal that
shows progress and applies the update (Windows self-installs and restarts; the
unsigned macOS build opens the Releases download page).

## Context (current state)

- `apps/desktop/electron-builder.json` — `appId com.rebase.app`, `productName
  Rebase`, mac (dmg+zip, hardened runtime) and win (nsis+zip) targets; the Go
  engine and renderer are bundled via `extraResources`. **No `publish` config.**
- `.github/workflows/release.yml` — on a `v*` tag, builds **macOS arm64 only**,
  packages **unsigned** (`CSC_IDENTITY_AUTO_DISCOVERY=false`), and attaches
  installers to a GitHub Release. Uses `--publish never`.
- The repo is **private** with **0 releases**. `electron-updater` is not a
  dependency. App version is `0.1.0`.

## Decisions

1. **Platforms:** macOS **and** Windows.
2. **Code signing:** unsigned for this milestone.
   - **Windows** self-updates today (NSIS); users see a SmartScreen warning.
   - **macOS unsigned cannot self-install** (Squirrel.Mac rejects unsigned
     updates), so its Update button **opens the Releases download page**.
   - The main-process gate and CI are written so that adding signing secrets
     later flips macOS to true self-update with no UI change.
3. **Update feed:** a dedicated **public** repo `motionz-kr/rebase-releases`
   holds only the installers + `latest.yml` / `latest-mac.yml`. The private
   source stays private; end-users read the feed tokenlessly via the
   `electron-updater` github provider.
4. **UX:** a **top-right Update button**, shown only when an update is available,
   opens a **modal popup** that shows loading/progress and drives the update. A
   **"Check for updates"** action in settings performs an on-demand check.
5. **Engine:** the Go engine is bundled in the app bundle, so a normal app
   update replaces it too — there is **no separate engine-update path**.

## Architecture

Three isolated units plus the release pipeline.

### `UpdateService` (main process) — `apps/desktop/src/main/updateService.ts`

Wraps `electron-updater`'s `autoUpdater`:

- Configure the github provider for `motionz-kr/rebase-releases`; set
  `autoDownload = false` and `autoInstallOnAppQuit = false` (the user drives it).
- Public methods: `check()`, `download()`, `installAndRestart()`.
- Subscribes to autoUpdater events and forwards a single neutral stream to the
  renderer over the `update-status` IPC channel:
  `{ kind: 'checking' | 'available' | 'not-available' | 'progress' | 'downloaded' | 'error',
     version?, notes?, percent?, message? }`.
- In an unpackaged/dev build (`!app.isPackaged`), `check()` does not touch the
  network; it is a no-op unless a test hook injects simulated events.

### Platform/signing gate (pure, TDD) — `apps/desktop/src/main/updatePolicy.ts`

```ts
type UpdateAction = 'self-update' | 'open-download-page' | 'disabled';
function resolveUpdateAction(platform: NodeJS.Platform, signed: boolean, packaged: boolean): UpdateAction;
```

- `!packaged` → `'disabled'` (dev).
- `darwin` && `!signed` → `'open-download-page'`.
- otherwise → `'self-update'`.

`signed` comes from a build-time constant `MAC_SELF_UPDATE` (default `false`);
flipping it on once signing lands changes macOS behaviour without touching the
renderer. The Releases page URL is a constant pointing at the public repo's
`/releases/latest`.

### IPC + preload + types

- Invokes: `update-check`, `update-download`, `update-install`.
- Event stream: `update-status` (main → renderer), bridged in preload as
  `onUpdateStatus(cb)`, with handles `updateCheck()`, `updateDownload()`,
  `updateInstall()` and types in `apps/renderer/src/global.d.ts`.

### Renderer

- **`useUpdater` hook + reducer** — `apps/renderer/src/lib/updateStatus.ts`
  (pure, TDD): folds the `update-status` event stream into
  `{ phase: 'idle'|'checking'|'available'|'downloading'|'downloaded'|'error',
    version?, percent?, message? }`.
- **`UpdateButton`** in the app's top-right toolbar (next to the engine-status
  indicator): rendered only when `phase` is `available | downloading | downloaded`.
- **`UpdateModal`** popup opened by the button: shows the version + release notes,
  a progress bar while downloading, and a **Restart to install** action once
  downloaded. On the macOS download-page path it shows a short explanation + an
  **Open download page** button instead of progress.
- **Settings:** a **Check for updates** row showing `checking / up to date /
  vX.Y.Z available`.

## Update feed & metadata

`electron-builder --publish always` generates and uploads `latest.yml` (Windows)
and `latest-mac.yml` (macOS) alongside the installers. Each lists the version,
file names, and **sha512** that `electron-updater` verifies after download.
`electron-updater` compares the running app version (from `package.json`) against
the feed's version using semver.

## Release & feed pipeline

- **`electron-builder.json`:** add
  `"publish": [{ "provider": "github", "owner": "motionz-kr", "repo": "rebase-releases" }]`.
- **`release.yml`:** on a `vX.Y.Z` tag, a 2-job matrix:
  - **macOS** (`macos-14`, arm64): cross-build engine for darwin/arm64, build
    renderer+desktop, `electron-builder --mac --publish always`.
  - **Windows** (`windows-latest`, x64): cross-build the Go engine with
    `GOOS=windows GOARCH=amd64`, build renderer+desktop,
    `electron-builder --win --publish always`.
  - Both jobs use a `GH_TOKEN` with write access to `motionz-kr/rebase-releases`
    so installers + `latest*.yml` land in a release **there**, not in the
    private source repo.
- **Versioning:** bump `version` in the desktop `package.json`, tag `vX.Y.Z`,
  push the tag → release. (The app reads its own version for the comparison.)

## UX flows

- **Launch:** `UpdateService.check()` runs silently. If `available`, the
  top-right Update button appears. If up to date, nothing shows.
- **Click Update (Windows):** open `UpdateModal` → `download()` → progress bar →
  on `downloaded`, the action becomes **Restart to install** → `installAndRestart()`.
- **Click Update (macOS unsigned):** `UpdateModal` explains a new version is
  available and offers **Open download page** (`shell.openExternal` to the public
  repo's latest release).
- **Manual check (settings):** `check()`; shows `checking` then either
  `up to date` or surfaces the same top-right button.
- **Dev/unpackaged:** the button is hidden; a test hook can inject simulated
  `update-status` events to exercise the UI.

## Error handling

- Launch/network failures during `check()` are silent (logged); a **manual**
  check surfaces the error inline.
- Download failures → the modal shows the error + **Retry**.
- Integrity: `electron-updater` validates sha512 from the metadata; a mismatch
  is reported as an `error` event and no install occurs.
- macOS unsigned never attempts a self-install (the policy gate prevents it).

## Testing strategy

- **Pure logic (TDD, red→green):**
  - `resolveUpdateAction(platform, signed, packaged)` — every branch.
  - semver `isNewer(current, candidate)`.
  - the renderer `updateStatus` reducer (event stream → UI phase).
- **Integration:** `UpdateService` event-forwarding wired to a fake autoUpdater
  emitter (assert each autoUpdater event maps to the right `update-status`).
- **Live (AGENTS Rule 0, CDP):** inject simulated `update-status` events through
  the IPC channel and assert the top-right button appears, the modal opens, the
  progress bar advances, and the Restart action shows.
- **Real end-to-end:** verify actual download+install on **Windows** (unsigned
  works); macOS true self-update is documented as **pending signing** and
  verified through the download-page fallback instead.

## Phasing (sub-projects → issues)

| Phase | Deliverable |
| --- | --- |
| **P1** | Feed & release pipeline: create public `rebase-releases` repo, add electron-builder `publish`, extend `release.yml` to build+publish macOS **and** Windows with `latest*.yml` metadata. |
| **P2** | Main `UpdateService` + `updatePolicy` gate + IPC/preload/types (TDD on the pure gate). |
| **P3** | Renderer: `useUpdater` reducer (TDD), top-right `UpdateButton`, `UpdateModal`, settings "Check for updates". |
| **P4** | macOS download-page fallback, signing-ready hooks (`MAC_SELF_UPDATE` flag + entitlements notes), and user/release docs. |

## Non-goals (YAGNI for v1)

Delta/differential updates; multiple release channels (beta/canary); silent
background auto-install; Linux packaging; a separate engine-only update channel;
actually signing/notarizing in this milestone (only the hooks); rollback to a
previous version.

## Open questions / risks

- **Cross-repo publish token:** the release workflow needs a `GH_TOKEN`
  (fine-grained PAT or app token) with write access to `rebase-releases`. The
  default `GITHUB_TOKEN` is scoped to the source repo only.
- **macOS self-update is blocked until signing** — the fallback ships now;
  flipping `MAC_SELF_UPDATE` requires an Apple Developer ID cert + notarization.
- **Windows SmartScreen** warns on unsigned installers until a Windows
  code-signing cert (e.g. OV/EV) is added; reputation also builds over time.
