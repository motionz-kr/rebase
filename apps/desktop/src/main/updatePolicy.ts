export type UpdateAction = 'self-update' | 'open-download-page' | 'disabled';

// The macOS build is signed with a real Apple Developer ID and notarized in CI
// (see .github/workflows/release.yml + electron-builder.json), so Squirrel.Mac
// accepts the in-app update install. Enable self-update on macOS — it now behaves
// like Windows. (If a build ever ships unsigned again, flip this back to false to
// avoid the wasted-download UX where quitAndInstall fails signature verification.)
export const MAC_SELF_UPDATE = true;

// Where the unsigned-macOS fallback sends users to download the new build.
export const RELEASES_PAGE_URL = 'https://github.com/motionz-kr/rebase/releases/latest';

export function resolveUpdateAction(
  platform: NodeJS.Platform,
  signed: boolean,
  packaged: boolean
): UpdateAction {
  if (!packaged) return 'disabled';
  if (platform === 'darwin' && !signed) return 'open-download-page';
  return 'self-update';
}
