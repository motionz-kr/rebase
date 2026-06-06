# Light / Dark / System Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-selectable Light / Dark / System theme to the Rebase Electron app (currently dark-only), defaulting to Dark.

**Architecture:** Hybrid — Electron `nativeTheme` in the main process is the source of truth and persists the choice to `userData/theme.json`; the renderer drives the UI via a `ThemeProvider` that toggles a `data-theme` attribute on `<html>` and reads CSS custom properties. Main passes the resolved theme to the renderer through `webPreferences.additionalArguments` (no startup flash) and broadcasts changes (including OS appearance changes in System mode).

**Tech Stack:** Electron 28 (`nativeTheme`, IPC), React 19 + Vite, plain CSS custom properties, Monaco (`@monaco-editor/react`), vitest, lucide-react icons.

Spec: `docs/superpowers/specs/2026-06-06-light-dark-theme-design.md`

---

## File Structure

**Create:**
- `apps/desktop/src/main/theme.ts` — pure theme helpers + JSON persistence (source of truth logic)
- `apps/desktop/src/main/theme.test.ts` — vitest unit tests for the above
- `apps/renderer/src/lib/theme.ts` — pure renderer-side types + `parseInjectedTheme`
- `apps/renderer/src/lib/theme.test.ts` — vitest unit test
- `apps/renderer/src/lib/ThemeContext.tsx` — `ThemeProvider` + `useTheme()`
- `apps/renderer/src/components/SettingsPopover.tsx` — gear button + theme segmented control

**Modify:**
- `apps/desktop/src/main/index.ts` — `nativeTheme` setup, window `backgroundColor`/`additionalArguments`, IPC handlers + broadcast
- `apps/desktop/src/preload/index.ts` — expose `window.__THEME__` + `getTheme`/`setThemeSource`/`onThemeUpdated`
- `apps/renderer/src/global.d.ts` — types for the new bridge methods + `__THEME__`
- `apps/renderer/src/main.tsx` — wrap `<App/>` in `<ThemeProvider>`
- `apps/renderer/src/index.css` — split tokens into `[data-theme="dark"]` / `[data-theme="light"]`
- `apps/renderer/index.html` — default `data-theme="dark"` + pre-paint bootstrap script
- `apps/renderer/src/components/QueryEditor.tsx` — Monaco theme from context
- `apps/renderer/src/App.tsx` — mount `<SettingsPopover/>` in the topbar
- `apps/renderer/src/App.css` — extract `--syntax-*` / `--text-danger` tokens; popover styles

---

## Task 1: Main-process theme module (pure + persistence)

**Files:**
- Create: `apps/desktop/src/main/theme.ts`
- Test: `apps/desktop/src/main/theme.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/main/theme.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  isThemeSource,
  parseThemeArgs,
  backgroundForResolved,
  loadThemeSource,
  saveThemeSource,
  DEFAULT_SOURCE,
} from './theme';

describe('theme helpers', () => {
  it('DEFAULT_SOURCE is dark', () => {
    expect(DEFAULT_SOURCE).toBe('dark');
  });

  it('isThemeSource validates known values', () => {
    expect(isThemeSource('light')).toBe(true);
    expect(isThemeSource('dark')).toBe(true);
    expect(isThemeSource('system')).toBe(true);
    expect(isThemeSource('blue')).toBe(false);
    expect(isThemeSource(undefined)).toBe(false);
    expect(isThemeSource(42)).toBe(false);
  });

  it('parseThemeArgs reads --theme / --theme-source', () => {
    expect(parseThemeArgs(['--theme=light', '--theme-source=system'])).toEqual({
      source: 'system',
      resolved: 'light',
    });
    expect(parseThemeArgs(['x', '--theme=dark', '--theme-source=dark', 'y'])).toEqual({
      source: 'dark',
      resolved: 'dark',
    });
  });

  it('parseThemeArgs falls back to dark on missing/invalid', () => {
    expect(parseThemeArgs([])).toEqual({ source: 'dark', resolved: 'dark' });
    expect(parseThemeArgs(['--theme=weird', '--theme-source=weird'])).toEqual({
      source: 'dark',
      resolved: 'dark',
    });
  });

  it('backgroundForResolved maps to window colors', () => {
    expect(backgroundForResolved('light')).toBe('#ffffff');
    expect(backgroundForResolved('dark')).toBe('#1e1f22');
  });

  it('loadThemeSource returns dark for missing/corrupt files', () => {
    expect(loadThemeSource(path.join(os.tmpdir(), 'rebase-no-such-theme.json'))).toBe('dark');
    const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'theme-')), 'bad.json');
    fs.writeFileSync(bad, 'not json');
    expect(loadThemeSource(bad)).toBe('dark');
  });

  it('saveThemeSource + loadThemeSource round-trip', () => {
    const fp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'theme-')), 'theme.json');
    saveThemeSource(fp, 'light');
    expect(loadThemeSource(fp)).toBe('light');
    saveThemeSource(fp, 'system');
    expect(loadThemeSource(fp)).toBe('system');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && npx vitest run src/main/theme.test.ts`
Expected: FAIL — cannot find module `./theme`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/desktop/src/main/theme.ts`:

```ts
import * as fs from 'fs';

export type ThemeSource = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const DEFAULT_SOURCE: ThemeSource = 'dark';

export function isThemeSource(x: unknown): x is ThemeSource {
  return x === 'light' || x === 'dark' || x === 'system';
}

/**
 * Parse `--theme=<resolved>` and `--theme-source=<source>` out of argv. These are
 * injected via BrowserWindow webPreferences.additionalArguments so the renderer
 * knows the resolved theme before first paint. Anything invalid falls back to dark.
 */
export function parseThemeArgs(argv: string[]): { source: ThemeSource; resolved: ResolvedTheme } {
  const read = (key: string): string | undefined => {
    const prefix = `--${key}=`;
    const hit = argv.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : undefined;
  };
  const s = read('theme-source');
  const source: ThemeSource = isThemeSource(s) ? s : DEFAULT_SOURCE;
  const resolved: ResolvedTheme = read('theme') === 'light' ? 'light' : 'dark';
  return { source, resolved };
}

export function backgroundForResolved(resolved: ResolvedTheme): string {
  return resolved === 'light' ? '#ffffff' : '#1e1f22';
}

export function loadThemeSource(filePath: string): ThemeSource {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { source?: unknown };
    return isThemeSource(parsed.source) ? parsed.source : DEFAULT_SOURCE;
  } catch {
    return DEFAULT_SOURCE;
  }
}

export function saveThemeSource(filePath: string, source: ThemeSource): void {
  fs.writeFileSync(filePath, JSON.stringify({ source }), 'utf8');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && npx vitest run src/main/theme.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/theme.ts apps/desktop/src/main/theme.test.ts
git commit -m "feat(theme): main-process theme helpers + persistence"
```

---

## Task 2: Renderer theme helper (pure)

**Files:**
- Create: `apps/renderer/src/lib/theme.ts`
- Test: `apps/renderer/src/lib/theme.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/renderer/src/lib/theme.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseInjectedTheme } from './theme';

describe('parseInjectedTheme', () => {
  it('reads valid injected values', () => {
    expect(parseInjectedTheme({ source: 'system', resolved: 'light' })).toEqual({
      source: 'system',
      resolved: 'light',
    });
  });

  it('defaults to dark on missing or invalid input', () => {
    expect(parseInjectedTheme(undefined)).toEqual({ source: 'dark', resolved: 'dark' });
    expect(parseInjectedTheme(null)).toEqual({ source: 'dark', resolved: 'dark' });
    expect(parseInjectedTheme({ source: 'x', resolved: 'y' })).toEqual({
      source: 'dark',
      resolved: 'dark',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/renderer && npx vitest run src/lib/theme.test.ts`
Expected: FAIL — cannot find module `./theme`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/renderer/src/lib/theme.ts`:

```ts
export type ThemeSource = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export interface InjectedTheme {
  source: ThemeSource;
  resolved: ResolvedTheme;
}

/** Normalize the `window.__THEME__` blob (or an IPC payload) into a safe shape. */
export function parseInjectedTheme(raw: unknown): InjectedTheme {
  const r = (raw ?? {}) as { source?: unknown; resolved?: unknown };
  const source: ThemeSource =
    r.source === 'light' || r.source === 'dark' || r.source === 'system' ? r.source : 'dark';
  const resolved: ResolvedTheme = r.resolved === 'light' ? 'light' : 'dark';
  return { source, resolved };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/renderer && npx vitest run src/lib/theme.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/renderer/src/lib/theme.ts apps/renderer/src/lib/theme.test.ts
git commit -m "feat(theme): renderer theme parse helper"
```

---

## Task 3: Main-process wiring (nativeTheme, window, IPC, broadcast)

No automated test (Electron runtime); covered by Task 1 unit tests + manual verification in Task 10. This task must keep `tsc` green.

**Files:**
- Modify: `apps/desktop/src/main/index.ts`

- [ ] **Step 1: Add imports**

In `apps/desktop/src/main/index.ts`, add `nativeTheme` to the electron import (line 1) and import the theme module after the other local imports (near line 9):

```ts
import { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme } from 'electron';
```

```ts
import {
  type ThemeSource,
  type ResolvedTheme,
  DEFAULT_SOURCE,
  isThemeSource,
  backgroundForResolved,
  loadThemeSource,
  saveThemeSource,
} from './theme';
```

- [ ] **Step 2: Add theme helpers (module scope)**

Add these helpers just above `function createWindow() {` (which currently starts around line 137, right after `resolveIconPath`):

```ts
function themeFilePath(): string {
  return path.join(app.getPath('userData'), 'theme.json');
}

function resolvedTheme(): ResolvedTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function broadcastTheme(): void {
  const payload = { source: nativeTheme.themeSource as ThemeSource, resolved: resolvedTheme() };
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('theme-updated', payload);
  }
}
```

- [ ] **Step 3: Initialize nativeTheme before the window is created**

In `startEngineAndApp()`, immediately before the `createWindow();` call (currently ~line 125), insert:

```ts
  // Restore the persisted theme choice and keep the renderer in sync when the OS
  // appearance changes while in 'system' mode.
  nativeTheme.themeSource = loadThemeSource(themeFilePath());
  nativeTheme.on('updated', () => broadcastTheme());
```

- [ ] **Step 4: Make the window theme-aware**

In `createWindow()`'s `new BrowserWindow({ ... })`, replace the hardcoded line:

```ts
    backgroundColor: '#1e1f22',
```

with:

```ts
    backgroundColor: backgroundForResolved(resolvedTheme()),
```

And inside the `webPreferences: { ... }` object (which currently has `preload`, `nodeIntegration`, `contextIsolation`, `sandbox`), add:

```ts
      additionalArguments: [
        `--theme=${resolvedTheme()}`,
        `--theme-source=${nativeTheme.themeSource}`,
      ],
```

- [ ] **Step 5: Register IPC handlers**

Find the block of `ipcMain.handle('update-...')` calls (around line 197-201) and add, right after `ipcMain.handle('update-simulate', ...)`:

```ts
  ipcMain.handle('theme-get', () => ({
    source: nativeTheme.themeSource as ThemeSource,
    resolved: resolvedTheme(),
  }));
  ipcMain.handle('theme-set-source', (_e, source: unknown) => {
    const next: ThemeSource = isThemeSource(source) ? source : DEFAULT_SOURCE;
    nativeTheme.themeSource = next;
    saveThemeSource(themeFilePath(), next);
    const payload = { source: next, resolved: resolvedTheme() };
    broadcastTheme();
    return payload;
  });
```

- [ ] **Step 6: Verify it compiles**

Run: `cd apps/desktop && npx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat(theme): wire nativeTheme, window background, and IPC in main"
```

---

## Task 4: Preload bridge + renderer types

No automated test (preload runs only in Electron). Keep `tsc` green; verified manually in Task 10.

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/renderer/src/global.d.ts`

- [ ] **Step 1: Expose `__THEME__` and add bridge methods**

In `apps/desktop/src/preload/index.ts`, add at the top (after the existing `import` line) a small argv reader and expose `__THEME__`. Do NOT import other local modules here — sandboxed preloads must stay dependency-free:

```ts
function readThemeArg(key: string): string | undefined {
  const prefix = `--${key}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

const injectedSource = readThemeArg('theme-source');
contextBridge.exposeInMainWorld('__THEME__', {
  source:
    injectedSource === 'light' || injectedSource === 'dark' || injectedSource === 'system'
      ? injectedSource
      : 'dark',
  resolved: readThemeArg('theme') === 'light' ? 'light' : 'dark',
});
```

Then add these three methods inside the existing `exposeInMainWorld('electronAPI', { ... })` object (e.g. after `onUpdateStatus`):

```ts
  getTheme: () => ipcRenderer.invoke('theme-get'),
  setThemeSource: (source: string) => ipcRenderer.invoke('theme-set-source', source),
  onThemeUpdated: (
    callback: (payload: { source: string; resolved: string }) => void,
  ) => {
    const listener = (_event: any, payload: any) => callback(payload);
    ipcRenderer.on('theme-updated', listener);
    return () => {
      ipcRenderer.removeListener('theme-updated', listener);
    };
  },
```

- [ ] **Step 2: Add renderer types**

In `apps/renderer/src/global.d.ts`, inside `declare global { interface Window { ... } }`:

Add a sibling property to `electronAPI` (e.g. right after the `electronAPI: { ... }` block closes, still inside `interface Window`):

```ts
    __THEME__?: { source: 'light' | 'dark' | 'system'; resolved: 'light' | 'dark' };
```

And inside the `electronAPI: { ... }` type, add (next to `onUpdateStatus`):

```ts
      getTheme: () => Promise<{ source: 'light' | 'dark' | 'system'; resolved: 'light' | 'dark' }>;
      setThemeSource: (
        source: 'light' | 'dark' | 'system',
      ) => Promise<{ source: 'light' | 'dark' | 'system'; resolved: 'light' | 'dark' }>;
      onThemeUpdated: (
        callback: (payload: { source: 'light' | 'dark' | 'system'; resolved: 'light' | 'dark' }) => void,
      ) => () => void;
```

- [ ] **Step 3: Verify it compiles**

Run: `cd apps/desktop && npx tsc --noEmit` (expect exit 0)
Run: `cd apps/renderer && npx tsc -b` (expect exit 0)

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/preload/index.ts apps/renderer/src/global.d.ts
git commit -m "feat(theme): preload bridge + renderer types"
```

---

## Task 5: ThemeProvider + useTheme, wired into the app root

**Files:**
- Create: `apps/renderer/src/lib/ThemeContext.tsx`
- Modify: `apps/renderer/src/main.tsx`

- [ ] **Step 1: Create the context**

Create `apps/renderer/src/lib/ThemeContext.tsx`:

```tsx
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { parseInjectedTheme, type ResolvedTheme, type ThemeSource } from './theme';

interface ThemeContextValue {
  source: ThemeSource;
  resolved: ResolvedTheme;
  setSource: (next: ThemeSource) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function applyResolved(resolved: ResolvedTheme): void {
  document.documentElement.setAttribute('data-theme', resolved);
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const initial = parseInjectedTheme(window.__THEME__);
  const [source, setSourceState] = useState<ThemeSource>(initial.source);
  const [resolved, setResolved] = useState<ResolvedTheme>(initial.resolved);

  // Keep the <html data-theme> attribute in sync with the resolved theme.
  useEffect(() => {
    applyResolved(resolved);
  }, [resolved]);

  // Main broadcasts on user changes (confirmation) and OS changes (system mode).
  useEffect(() => {
    const unsubscribe = window.electronAPI.onThemeUpdated((payload) => {
      const p = parseInjectedTheme(payload);
      setSourceState(p.source);
      setResolved(p.resolved);
    });
    return unsubscribe;
  }, []);

  const setSource = useCallback((next: ThemeSource) => {
    setSourceState(next); // optimistic; reconciled by the broadcast below
    window.electronAPI.setThemeSource(next).then((payload) => {
      const p = parseInjectedTheme(payload);
      setSourceState(p.source);
      setResolved(p.resolved);
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ source, resolved, setSource }}>
      {children}
    </ThemeContext.Provider>
  );
};

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}
```

- [ ] **Step 2: Wrap the app**

Modify `apps/renderer/src/main.tsx` to import and wrap:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import { ThemeProvider } from './lib/ThemeContext'
import 'pretendard/dist/web/variable/pretendardvariable.css'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
)
```

- [ ] **Step 3: Verify it compiles**

Run: `cd apps/renderer && npx tsc -b`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/renderer/src/lib/ThemeContext.tsx apps/renderer/src/main.tsx
git commit -m "feat(theme): ThemeProvider context wired into app root"
```

---

## Task 6: CSS token split + light palette + bootstrap

**Files:**
- Modify: `apps/renderer/src/index.css`
- Modify: `apps/renderer/index.html`

- [ ] **Step 1: Restructure tokens in index.css**

Replace the entire `:root { ... }` block (currently lines 9-61, ending just before `* { box-sizing: border-box; }`) with the following. Non-color tokens stay in `:root`; color tokens move into theme blocks; `[data-theme="light"]` is new. The dark values are identical to today.

```css
:root {
  --radius-sm: 4px;
  --radius: 6px;
  --radius-lg: 10px;

  --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --sans: 'Pretendard Variable', Pretendard, -apple-system, BlinkMacSystemFont, system-ui, sans-serif;

  /* Driver brand colors — shared across themes */
  --driver-mysql: #e8a33d;
  --driver-postgres: #5b9bd5;
  --driver-redis: #e0563f;

  font-family: var(--sans);
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}

[data-theme="dark"] {
  color-scheme: dark;

  --bg: #1e1f22;
  --bg-panel: #2b2d30;
  --bg-panel-2: #2b2d30;
  --bg-input: #1e1f22;
  --bg-hover: rgba(255, 255, 255, 0.06);
  --bg-active: rgba(255, 255, 255, 0.09);

  --border: #393b40;
  --border-strong: #4a4d52;

  --text: #dfe1e5;
  --text-2: #bcbec4;
  --text-3: #6f737a;

  --accent: #3574f0;
  --accent-hover: #4a82f2;
  --accent-press: #2c66d9;
  --accent-soft: rgba(53, 116, 240, 0.16);
  --accent-border: rgba(53, 116, 240, 0.5);

  --green: #5fad65;
  --green-soft: rgba(95, 173, 101, 0.15);
  --red: #db5c5c;
  --red-soft: rgba(219, 92, 92, 0.15);
  --amber: #d6a332;
  --amber-soft: rgba(214, 163, 50, 0.15);

  --shadow-pop: 0 10px 34px rgba(0, 0, 0, 0.5);

  /* SQL autocomplete syntax + danger text (see Task 9) */
  --syntax-table: #ffcb6b;
  --syntax-function: #82aaff;
  --syntax-keyword: #c792ea;
  --text-danger: #ff9b9b;
}

[data-theme="light"] {
  color-scheme: light;

  --bg: #ffffff;
  --bg-panel: #f3f4f6;
  --bg-panel-2: #ffffff;
  --bg-input: #ffffff;
  --bg-hover: rgba(0, 0, 0, 0.05);
  --bg-active: rgba(0, 0, 0, 0.08);

  --border: #e3e5e8;
  --border-strong: #c8cbd0;

  --text: #1f2328;
  --text-2: #4a4d52;
  --text-3: #8b8f96;

  --accent: #3574f0;
  --accent-hover: #2c66d9;
  --accent-press: #2459c4;
  --accent-soft: rgba(53, 116, 240, 0.12);
  --accent-border: rgba(53, 116, 240, 0.45);

  --green: #3f9142;
  --green-soft: rgba(63, 145, 66, 0.12);
  --red: #c4453f;
  --red-soft: rgba(196, 69, 63, 0.12);
  --amber: #b07d18;
  --amber-soft: rgba(176, 125, 24, 0.14);

  --shadow-pop: 0 10px 30px rgba(0, 0, 0, 0.16);

  --syntax-table: #b45309;
  --syntax-function: #2563eb;
  --syntax-keyword: #7c3aed;
  --text-danger: #c4453f;
}
```

- [ ] **Step 2: Add the body background rule**

`color-scheme` does not paint a background. Ensure the app surface uses `--bg`. Search `index.css` for an existing `body`/`html` background rule. If a `body { background: ... }` rule exists, confirm it uses `var(--bg)`; if there is none, add at the end of `index.css`:

```css
html, body {
  margin: 0;
  background: var(--bg);
}
```

- [ ] **Step 3: Default attribute + pre-paint bootstrap in index.html**

In `apps/renderer/index.html`, set the default theme attribute and read the preload-injected value before the bundle loads. Change `<html lang="en">` to `<html lang="en" data-theme="dark">`, and add the inline script in `<head>` (after the `<meta charset>` line):

```html
    <script>
      try {
        var t = window.__THEME__;
        if (t && (t.resolved === 'light' || t.resolved === 'dark')) {
          document.documentElement.setAttribute('data-theme', t.resolved);
        }
      } catch (e) {}
    </script>
```

- [ ] **Step 4: Verify dark mode is visually unchanged**

Run: `cd apps/renderer && npx vite build`
Expected: build succeeds. (Visual confirmation happens in Task 10; dark token values are byte-identical to before.)

- [ ] **Step 5: Commit**

```bash
git add apps/renderer/src/index.css apps/renderer/index.html
git commit -m "feat(theme): split CSS tokens into dark/light + bootstrap"
```

---

## Task 7: Settings popover with theme segmented control

**Files:**
- Create: `apps/renderer/src/components/SettingsPopover.tsx`
- Modify: `apps/renderer/src/App.tsx`
- Modify: `apps/renderer/src/App.css`

- [ ] **Step 1: Create the popover component**

Create `apps/renderer/src/components/SettingsPopover.tsx`:

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { Settings, Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from '../lib/ThemeContext';
import type { ThemeSource } from '../lib/theme';

const OPTIONS: { value: ThemeSource; label: string; icon: React.ReactNode }[] = [
  { value: 'light', label: '라이트', icon: <Sun size={14} /> },
  { value: 'dark', label: '다크', icon: <Moon size={14} /> },
  { value: 'system', label: '시스템', icon: <Monitor size={14} /> },
];

export const SettingsPopover: React.FC = () => {
  const { source, setSource } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="settings-popover-wrap" ref={ref}>
      <button
        className={`icon-btn${open ? ' active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="설정"
      >
        <Settings size={14} />
      </button>
      {open && (
        <div className="settings-popover" role="menu">
          <div className="settings-popover-label">테마</div>
          <div className="theme-segmented">
            {OPTIONS.map((o) => (
              <button
                key={o.value}
                className={`theme-seg${source === o.value ? ' selected' : ''}`}
                onClick={() => setSource(o.value)}
                role="menuitemradio"
                aria-checked={source === o.value}
              >
                {o.icon}
                <span>{o.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
```

- [ ] **Step 2: Mount it in the topbar**

In `apps/renderer/src/App.tsx`, add the import near the other component imports:

```tsx
import { SettingsPopover } from './components/SettingsPopover';
```

Then, inside `<div className="topbar-status">` (around line 459), add `<SettingsPopover />` as the last child, immediately after the update-check button:

```tsx
          <button className="icon-btn" onClick={() => window.electronAPI.updateCheck()} title="업데이트 확인">
            <DownloadCloud size={14} />
          </button>
          <SettingsPopover />
```

- [ ] **Step 3: Add popover styles**

Append to `apps/renderer/src/App.css`:

```css
/* Settings popover + theme segmented control */
.settings-popover-wrap {
  position: relative;
  display: inline-flex;
}
.settings-popover {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 50;
  min-width: 210px;
  padding: 10px;
  background: var(--bg-panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop);
}
.settings-popover-label {
  font-size: 11px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 6px;
}
.theme-segmented {
  display: flex;
  gap: 2px;
  padding: 2px;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.theme-seg {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  font-family: var(--sans);
  cursor: pointer;
}
.theme-seg:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.theme-seg.selected {
  background: var(--accent);
  color: #fff;
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd apps/renderer && npx tsc -b`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/renderer/src/components/SettingsPopover.tsx apps/renderer/src/App.tsx apps/renderer/src/App.css
git commit -m "feat(theme): settings popover with Light/Dark/System control"
```

---

## Task 8: Monaco editor follows the theme

**Files:**
- Modify: `apps/renderer/src/components/QueryEditor.tsx`

- [ ] **Step 1: Read the theme in QueryEditor**

Add the import near the other relative imports (e.g. after the `uiPrefs` import on line 13):

```tsx
import { useTheme } from '../lib/ThemeContext';
```

Inside the `QueryEditor` component body (after line 93, alongside the other hooks/state), add:

```tsx
  const { resolved } = useTheme();
```

- [ ] **Step 2: Swap the Monaco theme prop**

On the `<MonacoEditor ... />` element (line ~602), replace:

```tsx
          theme="vs-dark"
```

with:

```tsx
          theme={resolved === 'light' ? 'vs' : 'vs-dark'}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd apps/renderer && npx tsc -b`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/renderer/src/components/QueryEditor.tsx
git commit -m "feat(theme): Monaco editor follows resolved theme"
```

---

## Task 9: Tokenize hardcoded autocomplete + danger colors

These literals break on a light background. Replace them with the `--syntax-*` / `--text-danger` tokens defined in Task 6 (dark values equal today's; light values adjusted). White-on-accent literals (`color: #fff` on accent/active backgrounds) are intentionally left as-is — white is correct on the accent in both themes.

**Files:**
- Modify: `apps/renderer/src/App.css`

- [ ] **Step 1: Replace the SQL autocomplete icon colors**

In `apps/renderer/src/App.css`:

- `.sql-ac-icon.table { color: #ffcb6b; }` → `color: var(--syntax-table);`
- `.sql-ac-icon.function { color: #82aaff; }` → `color: var(--syntax-function);`
- `.sql-ac-icon.keyword { color: #c792ea; }` → `color: var(--syntax-keyword);`

- [ ] **Step 2: Replace the danger/error text colors**

- `.hist-err { ... color: #ff9b9b; }` → `color: var(--text-danger);`
- `.alert.error { ... color: #ffb3b3; }` → `color: var(--text-danger);`
- `.ctx-item.danger { color: #ff6b6b; }` → `color: var(--text-danger);`
- `.form-label.danger { color: #ff6b6b; }` → `color: var(--text-danger);`

(This unifies three near-identical error reds onto one token; the dark value `#ff9b9b` keeps dark mode visually equivalent.)

- [ ] **Step 3: Verify no stray non-variable hex remains in those rules**

Run: `cd apps/renderer && grep -nE "#(ffcb6b|82aaff|c792ea|ff9b9b|ffb3b3|ff6b6b)" src/App.css`
Expected: no matches.

- [ ] **Step 4: Verify build**

Run: `cd apps/renderer && npx vite build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/renderer/src/App.css
git commit -m "feat(theme): tokenize autocomplete + danger colors for theming"
```

---

## Task 10: Manual verification

No code. Validate the whole feature end-to-end in the running app.

- [ ] **Step 1: Build the renderer and launch the app**

Run (from repo root):
```bash
pnpm --filter renderer build
pnpm --filter desktop build
```
Then start the renderer dev server and Electron per the project's normal dev flow (renderer on :5173, then `electron .` from `apps/desktop`).

- [ ] **Step 2: Verify each mode**

Open the gear icon in the topbar → the theme segmented control. Confirm:
- Default on first run (delete `~/Library/Application Support/<app>/theme.json` first) is **Dark**, visually identical to before.
- Selecting **Light** switches the entire UI (sidebar, editor, panels, popovers) to the light palette with no unreadable text; the Monaco editor switches to `vs`.
- Selecting **Dark** returns to the dark palette and `vs-dark`.
- Selecting **System** matches the current macOS appearance.

- [ ] **Step 3: Verify no startup flash**

With theme set to Light, fully quit and relaunch. The window must paint light immediately (no dark flash). Repeat with Dark.

- [ ] **Step 4: Verify System follows the OS live**

Set mode to **System**. Change the macOS appearance (System Settings → Appearance) between Light and Dark while the app is open. The app must follow within a moment without a restart.

- [ ] **Step 5: Run the full unit test suites**

Run: `pnpm --filter desktop test` (expect theme tests + existing tests green)
Run: `cd apps/renderer && npx vitest run` (expect theme tests green)

- [ ] **Step 6: Final commit (if any tweaks were needed)**

```bash
git add -A
git commit -m "test(theme): manual verification adjustments"
```

(If no tweaks were needed, skip.)

---

## Notes for the implementer

- **Sandboxed preload:** `apps/desktop/src/preload/index.ts` runs with `sandbox: true`. Keep it dependency-free (no local imports); the inline argv parsing in Task 4 is deliberate.
- **`nativeTheme.themeSource`** returns exactly `'system' | 'light' | 'dark'`, matching `ThemeSource` — no mapping needed.
- **Dark parity:** the dark token values in Task 6 are copied verbatim from the original `:root`; the only intentional dark change is unifying three error-text reds onto `--text-danger` (`#ff9b9b`) in Task 9.
- **Renderer tests** run under vitest's default node environment (the new helpers are pure; no DOM/testing-library needed). React wiring and Monaco are validated manually in Task 10.
