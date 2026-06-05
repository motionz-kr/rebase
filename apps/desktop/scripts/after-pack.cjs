const { execSync } = require('node:child_process');
const path = require('node:path');

// Ad-hoc re-sign the whole .app on macOS.
//
// We ship a free, unsigned build (no Apple Developer ID), so electron-builder
// does no Developer ID signing. But on Apple Silicon every app must carry at
// least a valid ad-hoc signature, and adding our own files (engine binary,
// renderer, etc.) invalidates Electron's bundled signature — which makes
// Gatekeeper report the app as "damaged" and refuse to launch.
//
// Re-signing the finished bundle with the ad-hoc identity ("-") gives it a
// valid signature again. Users still clear the download quarantine on first
// run (right-click → Open, or `xattr -cr /Applications/Rebase.app`); see README.
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  // When a real Developer ID cert is provided (CI publish: CSC_LINK is set),
  // electron-builder does proper hardened-runtime signing + notarization. Skip
  // the ad-hoc re-sign so it doesn't clobber that valid signature. Only the
  // free, secret-less builds (local dev, fork PRs) fall through to ad-hoc.
  if (process.env.CSC_LINK) return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  execSync(`codesign --force --deep --sign - ${JSON.stringify(appPath)}`, { stdio: 'inherit' });
};
