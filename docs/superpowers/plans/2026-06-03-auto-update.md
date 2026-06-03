# Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship in-app auto-update — on launch the app checks a public feed and, when a newer version exists, shows a top-right **Update** button that opens a modal driving the update (Windows self-installs; unsigned macOS opens the Releases page).

**Architecture:** A main-process `UpdateService` wraps `electron-updater`, gated by a pure `resolveUpdateAction(platform, signed, packaged)` policy. It forwards a neutral `update-status` event stream over IPC. The renderer folds that stream with a pure reducer into a top-right `UpdateButton` + `UpdateModal`. Releases (installers + `latest*.yml`) are published by CI to a dedicated **public** `motionz-kr/rebase-releases` repo so the private source stays private and clients read the feed tokenlessly.

**Tech Stack:** Electron 28, `electron-updater`, electron-builder (github publish provider), Vite/React 19 renderer, Go engine (bundled, cross-built per-OS), vitest (unit), Playwright/CDP (live).

**Spec:** `docs/superpowers/specs/2026-06-03-auto-update-design.md`

**Shared status shape** (used by main, preload, renderer — keep identical):

```ts
type UpdateStatus =
  | { kind: 'checking' }
  | { kind: 'available'; version: string; notes?: string }
  | { kind: 'not-available' }
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };
```

---

## Phase P1 — Feed & release pipeline

### Task 1: Add the `electron-updater` dependency

**Files:**
- Modify: `apps/desktop/package.json`

- [ ] **Step 1: Add the dependency**

Run from repo root:

```bash
pnpm --filter desktop add electron-updater@6.3.9
```

- [ ] **Step 2: Verify it resolved**

Run: `pnpm --filter desktop exec node -e "require('electron-updater'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/package.json pnpm-lock.yaml
git commit -m "build(desktop): add electron-updater dependency"
```

### Task 2: Create the public releases repo

**Files:** none (GitHub infra).

- [ ] **Step 1: Create `motionz-kr/rebase-releases` (public)**

Try the API (needs an org-write token; `$GH_PAT` = a token with `repo` scope on the org):

```bash
curl -s -X POST -H "Authorization: token $GH_PAT" \
  https://api.github.com/orgs/motionz-kr/repos \
  -d '{"name":"rebase-releases","private":false,"description":"Public update feed + installers for Rebase (source is private)."}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('full_name'), d.get('private'))"
```

Expected: `motionz-kr/rebase-releases False`. If the API returns a permissions error, create it manually in the GitHub UI (New repo → Public → name `rebase-releases`) and continue.

- [ ] **Step 2: Seed an initial empty release tag holder**

No action needed — electron-builder creates the GitHub Release on first publish.

### Task 3: Add electron-builder publish config

**Files:**
- Modify: `apps/desktop/electron-builder.json`

- [ ] **Step 1: Add the `publish` block**

Add this top-level key to `apps/desktop/electron-builder.json` (sibling of `"mac"`/`"win"`):

```json
  "publish": [
    {
      "provider": "github",
      "owner": "motionz-kr",
      "repo": "rebase-releases"
    }
  ],
```

- [ ] **Step 2: Verify the JSON is valid**

Run: `python3 -c "import json; json.load(open('apps/desktop/electron-builder.json')); print('valid')"`
Expected: `valid`.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/electron-builder.json
git commit -m "build(desktop): publish updates to public rebase-releases repo"
```

### Task 4: Extend the release workflow to mac + win and publish the feed

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Replace the workflow with a mac+win matrix that publishes**

Replace the entire contents of `.github/workflows/release.yml` with:

```yaml
name: Release

# Build macOS + Windows and publish installers + update metadata
# (latest*.yml) to the public motionz-kr/rebase-releases repo.
# Triggers on a version tag push (e.g. `v0.1.0`); also runnable manually.
on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:

permissions:
  contents: write

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-14
            platform: mac
            goos: darwin
            goarch: arm64
          - os: windows-latest
            platform: win
            goos: windows
            goarch: amd64
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - name: Set up pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 8.15.9

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: pnpm

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version-file: go.mod

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Unit tests (renderer + desktop)
        run: |
          pnpm --filter renderer test
          pnpm --filter desktop test

      - name: Build the Go engine
        env:
          GOOS: ${{ matrix.goos }}
          GOARCH: ${{ matrix.goarch }}
        shell: bash
        run: go build -o apps/desktop/bin/app-engine${{ matrix.platform == 'win' && '.exe' || '' }} ./engine/cmd/app-engine

      - name: Build renderer + desktop
        run: |
          pnpm --filter renderer build
          pnpm --filter desktop build

      - name: Package + publish (${{ matrix.platform }})
        working-directory: apps/desktop
        env:
          GH_TOKEN: ${{ secrets.RELEASES_TOKEN }}
          CSC_IDENTITY_AUTO_DISCOVERY: 'false'
        shell: bash
        run: pnpm exec electron-builder --${{ matrix.platform }} --publish always
```

- [ ] **Step 2: Document the required secret**

The workflow needs a repo secret `RELEASES_TOKEN` — a PAT (classic, `repo` scope, or fine-grained with Contents:write on `rebase-releases`) so electron-builder can create releases in the public repo. Add it under the **private** repo's Settings → Secrets → Actions. (This is a manual GitHub step; note it in the PR description.)

- [ ] **Step 3: Validate the YAML**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('valid yaml')"`
Expected: `valid yaml`. (If `yaml` is missing: `pip3 install pyyaml` or skip — GitHub validates on push.)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): build+publish macOS & Windows to public update feed"
```

---

## Phase P2 — Main `UpdateService`, policy gate, IPC

### Task 5: Pure update-action policy (TDD)

**Files:**
- Create: `apps/desktop/src/main/updatePolicy.ts`
- Test: `apps/desktop/src/main/updatePolicy.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { resolveUpdateAction } from './updatePolicy';

describe('resolveUpdateAction', () => {
  it('is disabled when not packaged (dev)', () => {
    expect(resolveUpdateAction('darwin', true, false)).toBe('disabled');
    expect(resolveUpdateAction('win32', false, false)).toBe('disabled');
  });
  it('opens the download page on unsigned macOS', () => {
    expect(resolveUpdateAction('darwin', false, true)).toBe('open-download-page');
  });
  it('self-updates on signed macOS', () => {
    expect(resolveUpdateAction('darwin', true, true)).toBe('self-update');
  });
  it('self-updates on Windows regardless of signing', () => {
    expect(resolveUpdateAction('win32', false, true)).toBe('self-update');
    expect(resolveUpdateAction('win32', true, true)).toBe('self-update');
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm --filter desktop test -- updatePolicy`
Expected: FAIL — cannot find module `./updatePolicy`.

- [ ] **Step 3: Implement the policy**

Create `apps/desktop/src/main/updatePolicy.ts`:

```ts
export type UpdateAction = 'self-update' | 'open-download-page' | 'disabled';

// Flip to true only once the macOS build is signed + notarized; until then an
// unsigned macOS app cannot self-install (Squirrel.Mac rejects it).
export const MAC_SELF_UPDATE = false;

// Where the unsigned-macOS fallback sends users to download the new build.
export const RELEASES_PAGE_URL = 'https://github.com/motionz-kr/rebase-releases/releases/latest';

export function resolveUpdateAction(
  platform: NodeJS.Platform,
  signed: boolean,
  packaged: boolean
): UpdateAction {
  if (!packaged) return 'disabled';
  if (platform === 'darwin' && !signed) return 'open-download-page';
  return 'self-update';
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `pnpm --filter desktop test -- updatePolicy`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/updatePolicy.ts apps/desktop/src/main/updatePolicy.test.ts
git commit -m "feat(update): pure platform/signing policy gate (TDD)"
```

### Task 6: Pure electron-updater event mapping (TDD)

**Files:**
- Create: `apps/desktop/src/main/updateEvents.ts`
- Test: `apps/desktop/src/main/updateEvents.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mapUpdaterEvent } from './updateEvents';

describe('mapUpdaterEvent', () => {
  it('maps checking-for-update', () => {
    expect(mapUpdaterEvent('checking-for-update', undefined)).toEqual({ kind: 'checking' });
  });
  it('maps update-available with version + notes', () => {
    expect(mapUpdaterEvent('update-available', { version: '0.2.0', releaseNotes: 'fixes' }))
      .toEqual({ kind: 'available', version: '0.2.0', notes: 'fixes' });
  });
  it('maps update-not-available', () => {
    expect(mapUpdaterEvent('update-not-available', { version: '0.1.0' })).toEqual({ kind: 'not-available' });
  });
  it('rounds download-progress percent', () => {
    expect(mapUpdaterEvent('download-progress', { percent: 42.7 })).toEqual({ kind: 'progress', percent: 43 });
  });
  it('maps update-downloaded with version', () => {
    expect(mapUpdaterEvent('update-downloaded', { version: '0.2.0' })).toEqual({ kind: 'downloaded', version: '0.2.0' });
  });
  it('maps error to a message string', () => {
    expect(mapUpdaterEvent('error', new Error('boom'))).toEqual({ kind: 'error', message: 'boom' });
  });
  it('ignores unknown events', () => {
    expect(mapUpdaterEvent('something-else', {})).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm --filter desktop test -- updateEvents`
Expected: FAIL — cannot find module `./updateEvents`.

- [ ] **Step 3: Implement the mapper**

Create `apps/desktop/src/main/updateEvents.ts`:

```ts
export type UpdateStatus =
  | { kind: 'checking' }
  | { kind: 'available'; version: string; notes?: string }
  | { kind: 'not-available' }
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

function notesToString(notes: unknown): string | undefined {
  if (typeof notes === 'string') return notes;
  return undefined; // release notes can be an array of objects; keep it simple
}

export function mapUpdaterEvent(event: string, payload: unknown): UpdateStatus | null {
  const p = (payload ?? {}) as { version?: string; releaseNotes?: unknown; percent?: number };
  switch (event) {
    case 'checking-for-update':
      return { kind: 'checking' };
    case 'update-available':
      return { kind: 'available', version: p.version ?? '', notes: notesToString(p.releaseNotes) };
    case 'update-not-available':
      return { kind: 'not-available' };
    case 'download-progress':
      return { kind: 'progress', percent: Math.round(p.percent ?? 0) };
    case 'update-downloaded':
      return { kind: 'downloaded', version: p.version ?? '' };
    case 'error':
      return { kind: 'error', message: payload instanceof Error ? payload.message : String(payload) };
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `pnpm --filter desktop test -- updateEvents`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/updateEvents.ts apps/desktop/src/main/updateEvents.test.ts
git commit -m "feat(update): pure electron-updater event mapping (TDD)"
```

### Task 7: `UpdateService` (wires autoUpdater + forwards events)

**Files:**
- Create: `apps/desktop/src/main/updateService.ts`

- [ ] **Step 1: Implement the service**

Create `apps/desktop/src/main/updateService.ts`:

```ts
import type { BrowserWindow } from 'electron';
import { app, shell } from 'electron';
import electronUpdater from 'electron-updater';
import { mapUpdaterEvent, type UpdateStatus } from './updateEvents';
import { resolveUpdateAction, MAC_SELF_UPDATE, RELEASES_PAGE_URL } from './updatePolicy';

const { autoUpdater } = electronUpdater;

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

  // Dev-only: lets a CDP/Playwright test drive the renderer UI without a real feed.
  simulate(status: UpdateStatus) {
    if (!app.isPackaged) this.emit(status);
  }
}
```

- [ ] **Step 2: Type-check (compiles with the rest in Task 8)**

No standalone test; verified by `tsc` in Task 8, Step 4.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/updateService.ts
git commit -m "feat(update): UpdateService wrapping electron-updater"
```

### Task 8: Wire IPC in main + preload + types

**Files:**
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/renderer/src/global.d.ts`

- [ ] **Step 1: Instantiate the service and register IPC in main**

In `apps/desktop/src/main/index.ts`, add the import near the other imports:

```ts
import { UpdateService } from './updateService';
```

After `mainWindow` is created and loads its URL (right after the `loadURL`/`loadFile` block), add:

```ts
  const updateService = new UpdateService();
  updateService.attach(mainWindow);
  // Check once shortly after launch (no-op in dev/unsigned-disabled).
  mainWindow.webContents.once('did-finish-load', () => void updateService.check());

  ipcMain.handle('update-check', () => updateService.check());
  ipcMain.handle('update-download', () => updateService.download());
  ipcMain.handle('update-install', () => updateService.installAndRestart());
  // Dev-only hook for live UI verification (guarded inside the service).
  ipcMain.handle('update-simulate', (_e, status) => updateService.simulate(status));
```

(If `ipcMain` is not already imported, add it to the existing `electron` import.)

- [ ] **Step 2: Expose the API in preload**

In `apps/desktop/src/preload/index.ts`, add inside the `exposeInMainWorld('electronAPI', { ... })` object:

```ts
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateDownload: () => ipcRenderer.invoke('update-download'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  updateSimulate: (status: any) => ipcRenderer.invoke('update-simulate', status),
  onUpdateStatus: (callback: (status: any) => void) => {
    const listener = (_event: any, status: any) => callback(status);
    ipcRenderer.on('update-status', listener);
    return () => {
      ipcRenderer.removeListener('update-status', listener);
    };
  },
```

- [ ] **Step 3: Add types to the renderer global**

In `apps/renderer/src/global.d.ts`, add this exported type near the top (after the existing `AgentStreamChunk` interface):

```ts
export type UpdateStatus =
  | { kind: 'checking' }
  | { kind: 'available'; version: string; notes?: string }
  | { kind: 'not-available' }
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };
```

And add to the `electronAPI` interface (alongside the other methods):

```ts
      updateCheck: () => Promise<void>;
      updateDownload: () => Promise<void>;
      updateInstall: () => Promise<void>;
      updateSimulate: (status: UpdateStatus) => Promise<void>;
      onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void;
```

- [ ] **Step 4: Type-check both packages**

Run: `pnpm --filter desktop build && pnpm --filter renderer build`
Expected: both succeed (tsc + vite), no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/renderer/src/global.d.ts
git commit -m "feat(update): IPC wiring (main + preload + types)"
```

---

## Phase P3 — Renderer UI

### Task 9: Pure update-status reducer (TDD)

**Files:**
- Create: `apps/renderer/src/lib/updateStatus.ts`
- Test: `apps/renderer/src/lib/updateStatus.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { updateReducer, initialUpdateState } from './updateStatus';

describe('updateReducer', () => {
  it('starts idle', () => {
    expect(initialUpdateState).toEqual({ phase: 'idle' });
  });
  it('checking → checking', () => {
    expect(updateReducer(initialUpdateState, { kind: 'checking' })).toEqual({ phase: 'checking' });
  });
  it('available carries version + notes', () => {
    expect(updateReducer(initialUpdateState, { kind: 'available', version: '0.2.0', notes: 'x' }))
      .toEqual({ phase: 'available', version: '0.2.0', notes: 'x' });
  });
  it('not-available → idle', () => {
    const s = updateReducer(initialUpdateState, { kind: 'available', version: '0.2.0' });
    expect(updateReducer(s, { kind: 'not-available' })).toEqual({ phase: 'idle' });
  });
  it('progress keeps version from the available state and sets percent', () => {
    const s = updateReducer(initialUpdateState, { kind: 'available', version: '0.2.0' });
    expect(updateReducer(s, { kind: 'progress', percent: 50 }))
      .toEqual({ phase: 'downloading', version: '0.2.0', percent: 50 });
  });
  it('downloaded → downloaded with version', () => {
    expect(updateReducer(initialUpdateState, { kind: 'downloaded', version: '0.2.0' }))
      .toEqual({ phase: 'downloaded', version: '0.2.0' });
  });
  it('error carries the message', () => {
    expect(updateReducer(initialUpdateState, { kind: 'error', message: 'boom' }))
      .toEqual({ phase: 'error', message: 'boom' });
  });
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `pnpm --filter renderer test -- updateStatus`
Expected: FAIL — cannot find module `./updateStatus`.

- [ ] **Step 3: Implement the reducer**

Create `apps/renderer/src/lib/updateStatus.ts`:

```ts
import type { UpdateStatus } from '../global';

export interface UpdateUiState {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  notes?: string;
  percent?: number;
  message?: string;
}

export const initialUpdateState: UpdateUiState = { phase: 'idle' };

export function updateReducer(state: UpdateUiState, s: UpdateStatus): UpdateUiState {
  switch (s.kind) {
    case 'checking':
      return { phase: 'checking', version: state.version };
    case 'available':
      return { phase: 'available', version: s.version, notes: s.notes };
    case 'not-available':
      return { phase: 'idle' };
    case 'progress':
      return { phase: 'downloading', version: state.version, percent: s.percent };
    case 'downloaded':
      return { phase: 'downloaded', version: s.version };
    case 'error':
      return { phase: 'error', message: s.message };
    default:
      return state;
  }
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `pnpm --filter renderer test -- updateStatus`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/renderer/src/lib/updateStatus.ts apps/renderer/src/lib/updateStatus.test.ts
git commit -m "feat(update): renderer update-status reducer (TDD)"
```

### Task 10: `UpdateButton` + `UpdateModal` component

**Files:**
- Create: `apps/renderer/src/components/UpdateButton.tsx`

- [ ] **Step 1: Implement the component**

Create `apps/renderer/src/components/UpdateButton.tsx`:

```tsx
import React, { useEffect, useReducer, useState } from 'react';
import { Download, X, Loader2, RefreshCw } from 'lucide-react';
import { updateReducer, initialUpdateState } from '../lib/updateStatus';

// macOS-unsigned download path is signalled by the main process opening the
// browser; for that case the modal shows an "opening download page" note.
export const UpdateButton: React.FC = () => {
  const [state, dispatch] = useReducer(updateReducer, initialUpdateState);
  const [open, setOpen] = useState(false);

  useEffect(() => window.electronAPI.onUpdateStatus((s) => dispatch(s)), []);

  const visible = state.phase === 'available' || state.phase === 'downloading' || state.phase === 'downloaded';
  if (!visible) return null;

  const onUpdate = () => {
    setOpen(true);
    if (state.phase === 'available') void window.electronAPI.updateDownload();
  };

  return (
    <>
      <button className="btn btn-primary btn-sm update-pill" onClick={onUpdate} title="Update available">
        <Download size={14} /> 업데이트
      </button>
      {open && (
        <div className="update-overlay" onClick={() => state.phase !== 'downloading' && setOpen(false)}>
          <div className="update-modal" onClick={(e) => e.stopPropagation()}>
            <div className="update-modal-head">
              <span>업데이트{state.version ? ` · ${state.version}` : ''}</span>
              {state.phase !== 'downloading' && (
                <button className="icon-btn" onClick={() => setOpen(false)}>
                  <X size={15} />
                </button>
              )}
            </div>
            <div className="update-modal-body">
              {state.phase === 'available' && (
                <p className="update-line">
                  <Loader2 size={15} className="spin" /> 업데이트를 준비하는 중…
                </p>
              )}
              {state.phase === 'downloading' && (
                <>
                  <p className="update-line">
                    <Loader2 size={15} className="spin" /> 다운로드 중… {state.percent ?? 0}%
                  </p>
                  <div className="update-bar">
                    <div className="update-bar-fill" style={{ width: `${state.percent ?? 0}%` }} />
                  </div>
                </>
              )}
              {state.phase === 'downloaded' && (
                <p className="update-line">다운로드 완료. 재시작하면 적용됩니다.</p>
              )}
              {state.phase === 'error' && <p className="update-line err">{state.message}</p>}
            </div>
            <div className="update-modal-actions">
              {state.phase === 'downloaded' && (
                <button className="btn btn-primary btn-sm" onClick={() => window.electronAPI.updateInstall()}>
                  <RefreshCw size={13} /> 재시작하여 설치
                </button>
              )}
              {state.phase === 'error' && (
                <button className="btn btn-secondary btn-sm" onClick={() => window.electronAPI.updateDownload()}>
                  다시 시도
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
```

- [ ] **Step 2: Type-check**

Run: `pnpm --filter renderer build`
Expected: succeeds (component compiles; not yet mounted).

- [ ] **Step 3: Commit**

```bash
git add apps/renderer/src/components/UpdateButton.tsx
git commit -m "feat(update): top-right Update button + progress modal"
```

### Task 11: Mount the button in the top bar + styles

**Files:**
- Modify: `apps/renderer/src/App.tsx`
- Modify: `apps/renderer/src/App.css`

- [ ] **Step 1: Mount `UpdateButton` in the top-right toolbar**

In `apps/renderer/src/App.tsx`, import it:

```tsx
import { UpdateButton } from './components/UpdateButton';
```

Place `<UpdateButton />` in the top bar, immediately before the engine-status indicator (search for the element that renders `Engine ready` / engine status near the top-right, and insert `<UpdateButton />` just before it).

- [ ] **Step 2: Add styles**

Append to `apps/renderer/src/App.css`:

```css
/* --- Auto-update --- */
.update-pill {
  margin-right: 8px;
}
.update-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.update-modal {
  width: 360px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop);
  overflow: hidden;
}
.update-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  font-size: 13px;
  font-weight: 600;
  border-bottom: 1px solid var(--border);
}
.update-modal-body {
  padding: 16px 14px;
}
.update-line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text);
}
.update-line.err {
  color: var(--red);
}
.update-bar {
  margin-top: 12px;
  height: 6px;
  border-radius: 3px;
  background: var(--bg);
  overflow: hidden;
}
.update-bar-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.15s ease;
}
.update-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 14px 14px;
}
.spin {
  animation: update-spin 1s linear infinite;
}
@keyframes update-spin {
  to {
    transform: rotate(360deg);
  }
}
```

- [ ] **Step 3: Type-check + lint**

Run: `pnpm --filter renderer build && pnpm --filter renderer lint`
Expected: build succeeds; eslint reports 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/renderer/src/App.tsx apps/renderer/src/App.css
git commit -m "feat(update): mount Update button in top bar + modal styles"
```

### Task 12: Settings "Check for updates" row

**Files:**
- Modify: `apps/renderer/src/App.tsx` (or the settings component it renders)

- [ ] **Step 1: Add a manual check control**

Find where app/global settings render (the gear/settings surface in `App.tsx`). Add a row:

```tsx
<button className="btn btn-secondary btn-sm" onClick={() => window.electronAPI.updateCheck()}>
  업데이트 확인
</button>
```

Place it in the settings area near version/about info. (If there is no settings surface in `App.tsx`, add it next to the engine-status indicator in the top bar as a small ghost button.)

- [ ] **Step 2: Type-check**

Run: `pnpm --filter renderer build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/renderer/src/App.tsx
git commit -m "feat(update): manual 'check for updates' control"
```

---

## Phase P4 — Live verification, fallback, docs

### Task 13: Live-verify the UI via simulated events (CDP)

**Files:** none (verification only).

- [ ] **Step 1: Rebuild + restart the app**

```bash
pnpm --filter renderer build >/dev/null
pnpm --filter desktop build >/dev/null
go build -o apps/desktop/bin/app-engine ./engine/cmd/app-engine
# restart Electron with --remote-debugging-port=9222 (see AGENTS Rule 0 runbook)
```

- [ ] **Step 2: Drive the `update-status` stream through the dev hook**

Via CDP `Runtime.evaluate` on the renderer page, run each and assert the UI:

```js
// 1) available → top-right button appears
await window.electronAPI.updateSimulate({ kind: 'available', version: '9.9.9', notes: 'test' });
// expect: document.querySelector('.update-pill') is present, text includes '업데이트'

// 2) click it → modal opens (download invoked; dev download is a no-op, so push progress)
document.querySelector('.update-pill').click();
await window.electronAPI.updateSimulate({ kind: 'progress', percent: 40 });
// expect: .update-modal visible, .update-bar-fill width ~40%

// 3) downloaded → "재시작하여 설치" button shows
await window.electronAPI.updateSimulate({ kind: 'downloaded', version: '9.9.9' });
// expect: .update-modal-actions button present

// 4) not-available resets → button hidden
await window.electronAPI.updateSimulate({ kind: 'not-available' });
// expect: .update-pill is gone
```

Expected: each assertion passes (capture a screenshot of the progress modal).

- [ ] **Step 3: No code change — if an assertion fails, fix the relevant component/CSS and re-run.**

### Task 14: macOS fallback note + signing-readiness docs

**Files:**
- Create: `docs/auto-update.md`
- Modify: `apps/desktop/electron-builder.json` (confirm mac signing fields are present for later)

- [ ] **Step 1: Write the operator/release doc**

Create `docs/auto-update.md` with: how releases work (bump version → tag `vX.Y.Z` → CI publishes to `rebase-releases`), the `RELEASES_TOKEN` secret requirement, the unsigned-macOS behavior (Update opens the Releases page; flip `MAC_SELF_UPDATE` + add Apple Developer ID cert/notarization to enable self-update), and the Windows SmartScreen note.

```md
# Auto-Update — operating notes

## Releasing
1. Bump `version` in `apps/desktop/package.json`.
2. Commit, then push a tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. CI (`release.yml`) builds macOS + Windows and publishes installers +
   `latest*.yml` to the public `motionz-kr/rebase-releases` repo.

## Required secret
`RELEASES_TOKEN` — a PAT with Contents:write on `motionz-kr/rebase-releases`
(electron-builder uses it to create the release in that repo).

## Platform behavior
- **Windows:** in-app self-update (NSIS). Unsigned ⇒ SmartScreen warning until a
  code-signing cert is added.
- **macOS (unsigned):** cannot self-install; the Update button opens the Releases
  page. To enable self-update later: obtain an Apple Developer ID cert, add the
  signing secrets to CI, notarize, and set `MAC_SELF_UPDATE = true` in
  `apps/desktop/src/main/updatePolicy.ts`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/auto-update.md
git commit -m "docs: auto-update release + signing notes"
```

### Task 15: Full regression + open the PR

**Files:** none.

- [ ] **Step 1: Run every check**

```bash
pnpm --filter renderer test && pnpm --filter renderer lint && pnpm --filter renderer build
pnpm --filter desktop test && pnpm --filter desktop build
go build ./engine/...
```

Expected: all green (renderer unit tests incl. updateStatus; desktop unit tests incl. updatePolicy + updateEvents).

- [ ] **Step 2: Push the branch and open a PR**

```bash
git push -u origin feat/auto-update
```

Open a PR into `main` titled `feat: in-app auto-update (electron-updater)` with a body summarizing the feed repo, platform behavior, and the `RELEASES_TOKEN` manual step. Closes the milestone #3 issues.

---

## Notes for the implementer

- **Engine path:** `~/.antigravity/metadata.db` and dev DBs are the user's — do not mutate them.
- **Restart runbook (AGENTS Rule 0):** kill the Electron process bound to `--remote-debugging-port=9222`, rebuild the changed layer (renderer = Vite HMR auto; desktop main = `pnpm --filter desktop build` + restart; engine = `go build -o apps/desktop/bin/app-engine ...` + restart), relaunch.
- **electron-updater only runs packaged.** Dev verification uses `updateSimulate` (guarded by `!app.isPackaged`). Real download/install is verified post-release on Windows; macOS self-update stays disabled until signing.
- **Co-author trailer** on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
