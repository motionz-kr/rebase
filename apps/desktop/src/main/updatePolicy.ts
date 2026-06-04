export type UpdateAction = 'self-update' | 'open-download-page' | 'disabled';

// Attempt in-app self-update on macOS. The build is only ad-hoc signed (no Apple
// Developer ID), so Squirrel.Mac MAY reject the install during code-signature
// verification. We try anyway — if it fails, updateService falls back to opening
// the Releases page (see its 'error' handler). Flip to false to disable the
// experiment and always use the page fallback.
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
