# macOS Developer ID Signing + Notarization + Self-Update — Design

**Date:** 2026-06-05
**Status:** Approved (pending implementation)

## Goal

Sign and notarize the macOS build with a real Apple Developer ID so the app installs
without Gatekeeper warnings and can self-update in-app (electron-updater), the same
way the Windows build already does. Replaces the ad-hoc signing + Releases-page
fallback that was forced by the lack of an Apple Developer ID.

## Decisions (locked)

- **Notarization credential:** App Store Connect API key (`.p8`) via notarytool. (Not Apple-ID/app-specific-password — avoids 2FA/credential churn in CI.)
- **Certificate:** Developer ID Application (G2 Sub-CA). Created fresh; private key + cert exported as `.p12`.
- **Architecture:** arm64 only (unchanged). No Intel/universal.
- **Self-update:** flip `MAC_SELF_UPDATE = true` in the same change.
- **Where signing runs:** CI (GitHub Actions), fully automated. Cert + keys live in encrypted repo secrets (not exposed to fork PRs).

## Secrets (6 repo secrets — already registered)

| Secret | Contents |
|---|---|
| `MAC_CSC_LINK` | base64 of the Developer ID Application `.p12` |
| `MAC_CSC_KEY_PASSWORD` | `.p12` export password |
| `APPLE_API_KEY_P8` | full text of the App Store Connect API key `.p8` |
| `APPLE_API_KEY_ID` | API Key ID |
| `APPLE_API_ISSUER` | API Issuer ID |
| `APPLE_TEAM_ID` | 10-char Team ID |

## Components / changes

### 1. `apps/desktop/electron-builder.json` (mac section)
- Remove `"identity": null` (null forces skip-signing).
- Add `"hardenedRuntime": true` (required for notarization).
- Add `"gatekeeperAssess": false`.
- Add `"entitlements": "build/entitlements.mac.plist"` and `"entitlementsInherit": "build/entitlements.mac.plist"`.
- Keep `"target": ["dmg", "zip"]`, arm64.
- Do **not** hardcode `notarize` in the JSON. Notarization is enabled only in the CI Publish step (env-driven), so the Package step and secret-less/fork builds never attempt it.

### 2. `apps/desktop/build/entitlements.mac.plist` (new)
Standard Electron hardened-runtime entitlements:
- `com.apple.security.cs.allow-jit`
- `com.apple.security.cs.allow-unsigned-executable-memory`
- `com.apple.security.cs.disable-library-validation` (lets the app spawn the bundled Go engine binary)
- `com.apple.security.cs.allow-dyld-environment-variables`

### 3. `apps/desktop/scripts/after-pack.cjs`
Make ad-hoc signing conditional: `if (process.env.CSC_LINK) return;` at the top.
When real Developer ID signing is active (CI Publish, `CSC_LINK` present), skip ad-hoc
so it does not clobber the real signature. Secret-less local/PR builds still ad-hoc
sign as before (so they launch).

### 4. `.github/workflows/release.yml` (mac job)
- **Package step** (`--publish never`): unchanged — stays unsigned/ad-hoc, used only for
  the smoke test. This avoids notarizing twice (notarization is slow).
- **New step (mac only):** write `APPLE_API_KEY_P8` to `$RUNNER_TEMP/authkey.p8` and
  export `APPLE_API_KEY=<that path>` to `$GITHUB_ENV`.
- **Publish step (mac):** add env `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY_ID`,
  `APPLE_API_ISSUER` (plus `APPLE_API_KEY` path from the prep step); set
  `CSC_IDENTITY_AUTO_DISCOVERY: 'true'`. No `notarize` config or `--config` flag is
  needed: electron-builder v24.13.3 (`macPackager.getNotarizeOptions`) auto-notarizes via
  notarytool whenever `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` are all set,
  unless `mac.notarize === false`. `APPLE_TEAM_ID` is not required for the API-key path.
  Keep the existing 3-attempt hdiutil retry loop. Windows job unchanged.
- **Per-platform scoping (critical):** `CSC_LINK`/`CSC_KEY_PASSWORD`/`CSC_IDENTITY_AUTO_DISCOVERY`
  are generic (mac AND win) electron-builder vars. They are gated with
  `${{ matrix.platform == 'mac' && secrets.X || '' }}` so the Windows build never receives
  the mac `.p12` (which would break Windows signing). With empty `CSC_LINK`, win stays
  unsigned as before. Secret-less/fork builds also fall through to unsigned, not failing.

### 5. `apps/desktop/src/main/updatePolicy.ts`
Flip `MAC_SELF_UPDATE` to `true`. `resolveUpdateAction(darwin, signed=true, packaged)` then
returns `'self-update'`, so macOS self-updates like Windows.

## Verification

No unit tests apply (CI/signing infra). Verify by:
- **CI logs:** notarytool reports success; release publishes `latest-mac.yml` + `.dmg` + `.zip`.
- **Local, on a downloaded artifact:**
  - `codesign --verify --deep --strict --verbose=2 Rebase.app` → valid.
  - `spctl -a -vvv -t install Rebase.app` → "accepted, source=Notarized Developer ID".
  - `stapler validate Rebase.app` → "The validate action worked".
- **Full update flow** is only end-to-end verifiable across two signed releases (first
  signed build → next). Documented as a manual follow-up check.

## Rollout caveat

The first signed release (e.g. **0.9.0**) cannot be auto-updated *into* by existing 0.8.0
macOS users (they are on the ad-hoc page-download build) — they install it manually once.
From that first signed build onward, in-app auto-update works.

## Out of scope

- Renderer-only OTA / hot updates (separate, on hold).
- Intel/universal macOS builds.
- Windows code signing (already self-updates; unsigned EXE unchanged).
