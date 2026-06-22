import type { BrowserWindow } from 'electron';
import { app, shell } from 'electron';
// electron-updater is CommonJS with named exports and no default export, so a
// default import resolves to undefined — use the named import.
import { autoUpdater } from 'electron-updater';
import { isUpdateMetadataPendingError, mapUpdaterEvent, type UpdateStatus } from './updateEvents';
import { resolveUpdateAction, MAC_SELF_UPDATE, RELEASES_PAGE_URL } from './updatePolicy';

const FEED_PENDING_RETRY_MS = 5 * 60 * 1000;

// UpdateService owns the electron-updater lifecycle and streams a neutral
// status to the renderer over the 'update-status' channel.
export class UpdateService {
  private win: BrowserWindow | null = null;
  private feedPendingRetry: NodeJS.Timeout | null = null;

  constructor() {
    autoUpdater.autoDownload = false;
    // Once an update is downloaded, apply it silently when the app quits — so even
    // if the user defers ("나중에"), the next launch is already on the new version.
    autoUpdater.autoInstallOnAppQuit = true;
    const forward = (event: string, payload?: unknown) => {
      const status = mapUpdaterEvent(event, payload);
      if (!status && event === 'error' && isUpdateMetadataPendingError(payload)) this.scheduleFeedPendingRetry();
      if (status) this.emit(status);
    };
    autoUpdater.on('checking-for-update', () => forward('checking-for-update'));
    autoUpdater.on('update-available', (i) => {
      forward('update-available', i);
      // Auto-download in the background when in-app self-update is supported, so
      // the user sees progress without clicking. (open-download-page providers —
      // unsigned macOS — must NOT auto-open a browser, hence the guard.)
      if (this.action() === 'self-update') void this.download();
    });
    autoUpdater.on('update-not-available', (i) => forward('update-not-available', i));
    autoUpdater.on('download-progress', (p) => forward('download-progress', p));
    autoUpdater.on('update-downloaded', (i) => forward('update-downloaded', i));
    autoUpdater.on('error', (e) => forward('error', e));
  }

  attach(win: BrowserWindow) {
    this.win = win;
  }

  private emit(status: UpdateStatus) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('update-status', status);
  }

  private action() {
    return resolveUpdateAction(process.platform, MAC_SELF_UPDATE, app.isPackaged);
  }

  private scheduleFeedPendingRetry() {
    if (this.feedPendingRetry) return;
    this.feedPendingRetry = setTimeout(() => {
      this.feedPendingRetry = null;
      void this.check();
    }, FEED_PENDING_RETRY_MS);
  }

  private emitUpdaterError(e: unknown) {
    if (isUpdateMetadataPendingError(e)) {
      this.scheduleFeedPendingRetry();
      return;
    }
    this.emit({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
  }

  async check() {
    if (this.action() === 'disabled') return; // dev / unpackaged: no network
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      this.emitUpdaterError(e);
    }
  }

  async download() {
    if (this.action() === 'open-download-page') {
      await shell.openExternal(RELEASES_PAGE_URL);
      return;
    }
    try {
      await autoUpdater.downloadUpdate();
    } catch (e) {
      this.emitUpdaterError(e);
    }
  }

  installAndRestart() {
    autoUpdater.quitAndInstall();
  }

  // Manual fallback: open the GitHub Releases page (used when a macOS ad-hoc
  // self-update fails Squirrel.Mac's signature check).
  openReleasesPage() {
    void shell.openExternal(RELEASES_PAGE_URL);
  }

  // Dev-only: lets a CDP/Playwright test drive the renderer UI without a real feed.
  simulate(status: UpdateStatus) {
    if (!app.isPackaged) this.emit(status);
  }
}
