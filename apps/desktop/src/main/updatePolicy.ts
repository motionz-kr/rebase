export type UpdateAction = 'self-update' | 'open-download-page' | 'disabled';

// Flip to true only once the macOS build is signed + notarized; until then an
// unsigned macOS app cannot self-install (Squirrel.Mac rejects it).
export const MAC_SELF_UPDATE = false;

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
