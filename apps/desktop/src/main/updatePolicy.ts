export type UpdateAction = 'self-update' | 'open-download-page' | 'disabled';

// In-app self-update on macOS requires an Apple Developer ID signature. Our build
// is only ad-hoc signed, and Squirrel.Mac rejects the install at code-signature
// verification (SQRLCodeSignatureErrorDomain) — confirmed by live test: the new
// version downloads to 100% but quitAndInstall fails. So on unsigned macOS we send
// users to the Releases page instead of wasting a download. Set to true ONLY once
// the build is signed+notarized with a real Developer ID. Windows/Linux are
// unaffected (they self-update regardless of this flag).
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
