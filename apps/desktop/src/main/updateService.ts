import type { BrowserWindow } from 'electron';
import { app, shell } from 'electron';
// electron-updater is CommonJS with named exports and no default export, so a
// default import resolves to undefined — use the named import.
import { autoUpdater } from 'electron-updater';
import { mapUpdaterEvent, type UpdateStatus } from './updateEvents';
import { resolveUpdateAction, MAC_SELF_UPDATE, RELEASES_PAGE_URL } from './updatePolicy';

// UpdateService owns the electron-updater lifecycle and streams a neutral
// status to the renderer over the 'update-status' channel.
export class UpdateService {
  private win: BrowserWindow | null = null;

  constructor() {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    const forward = (event: string, payload?: unknown) => {
      const status = mapUpdaterEvent(event, payload);
      if (status) this.emit(status);
    };
    autoUpdater.on('checking-for-update', () => forward('checking-for-update'));
    autoUpdater.on('update-available', (i) => forward('update-available', i));
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

  async check() {
    if (this.action() === 'disabled') return; // dev / unpackaged: no network
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      this.emit({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
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
      this.emit({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
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
