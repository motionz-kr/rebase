# Light / Dark / System Theme — Design

**Date:** 2026-06-06
**Status:** Approved (design)
**Branch:** `feat/theme-light-dark`

## Goal

The app (Rebase, an Electron desktop database manager) is currently dark-only.
Add a user-selectable theme with three modes — **Light**, **Dark**, and
**System** (follow the OS) — with Dark remaining the default.

## Context

The renderer is already well-suited for theming:

- Plain CSS, no Tailwind/CSS-in-JS. All color tokens are centralized as CSS
  custom properties in `apps/renderer/src/index.css` (`:root`, ~35 tokens), and
  components reference them via `var(--*)` (~597 references in `App.css`). There
  are no scattered color literals in JSX/inline styles.
- Only ~14 hardcoded color literals remain in CSS — the SQL autocomplete syntax
  icon colors in `App.css`.
- There is **no** existing theme infrastructure (no context, no
  `prefers-color-scheme`, no `data-theme`, no persistence, no `nativeTheme`
  usage). The main process hardcodes `backgroundColor: '#1e1f22'`.
- The Monaco editor is set to `vs-dark` in `QueryEditor.tsx`.
- Autocomplete uses a custom React dropdown (not Monaco's native suggest widget),
  styled via CSS — it will theme automatically once tokens are split, except for
  the ~14 hardcoded syntax-icon colors.

## Decisions

| Question | Decision |
|---|---|
| Modes | Light / Dark / System |
| Control location | Settings popover (gear icon in topbar) with a segmented control |
| Default | Dark (preserve current experience for existing users) |
| Light palette | Derived from existing tokens (IntelliJ-Light-style), refined live in-app |
| Architecture | **C — Hybrid:** `nativeTheme` (main) is the source of truth; renderer owns the UX |

## Architecture (C — Hybrid)

Source of truth is the main process's Electron `nativeTheme`. The user's choice
(`'light' | 'dark' | 'system'`) is persisted by main; the renderer drives the
UI and applies CSS, but defers ownership of the resolved value to main.

### Data flow

1. **Persistence:** main stores the chosen `source` in `userData/theme.json`
   (`{ "source": "light" | "dark" | "system" }`). Default when absent: `dark`.
2. **Startup (no flash):** on `app.whenReady`, main loads `source`, sets
   `nativeTheme.themeSource = source`. It then reads
   `nativeTheme.shouldUseDarkColors` to get the **resolved** theme
   (`'light' | 'dark'`) and:
   - creates the `BrowserWindow` with `backgroundColor` set from the resolved
     theme (e.g. `#1e1f22` dark / `#ffffff` light), removing the hardcoded value;
   - passes the resolved theme to the renderer via
     `webPreferences.additionalArguments: ['--theme=<resolved>', '--theme-source=<source>']`.
3. **Preload bridge:** preload reads the args and exposes, on `window`:
   - `window.__THEME__ = { source, resolved }` (synchronous, available before the
     page's own scripts run → renderer applies `data-theme` before first paint);
   - new methods on the **existing `electronAPI` bridge**
     (`contextBridge.exposeInMainWorld('electronAPI', …)` in `preload/index.ts`):
     `getTheme()`, `setThemeSource(source)`, `onThemeUpdated(cb) → unsubscribe`.
   - IPC channels follow the existing kebab-case convention: `theme-get`
     (invoke), `theme-set-source` (invoke), and a `theme-updated` broadcast event
     (main → renderer via `webContents.send`).
4. **Change:** the renderer's segmented control calls `setThemeSource(source)`.
   Main persists it, sets `nativeTheme.themeSource`, recomputes the resolved
   theme, and broadcasts `{ source, resolved }` to all windows.
5. **System changes:** in `system` mode, when the OS theme changes,
   `nativeTheme.on('updated')` fires in main → main broadcasts the new resolved
   theme → renderer updates `data-theme` and Monaco.

### Renderer — ThemeProvider

A new React context `ThemeProvider` exposing `{ source, resolved, setSource }`:

- Initializes **synchronously** from `window.__THEME__` and immediately applies
  `document.documentElement.setAttribute('data-theme', resolved)` (no in-renderer
  flash).
- `setSource(next)` updates `source` optimistically and calls
  `window.electronAPI.setThemeSource(next)`. The subsequent `theme-updated`
  broadcast from main is the authority and reconciles `{ source, resolved }`.
- Subscribes via `onThemeUpdated` to reflect main-driven changes (system updates
  and confirmed user changes); updates `data-theme` and context state.
- Unsubscribes on unmount.

### CSS token restructure — `apps/renderer/src/index.css`

- Move the existing color tokens from `:root` into a `[data-theme="dark"]` block,
  **values unchanged** (dark mode is visually identical to today).
- Add a `[data-theme="light"]` block with the light palette below.
- Keep non-color tokens (radii, fonts, spacing) in `:root`.
- `index.html` sets `<html data-theme="dark">` as a pre-bootstrap safety default.
- Extract the ~14 hardcoded autocomplete syntax-icon colors in `App.css` into
  `--syntax-*` tokens, defined per theme.

### Light palette (initial — refined live in-app)

IntelliJ-Light-style, keeping the existing accent blue:

```
--bg:            #ffffff
--bg-panel:      #f3f4f6
--bg-panel-2:    #ffffff
--bg-input:      #ffffff
--bg-hover:      rgba(0,0,0,0.05)
--bg-active:     rgba(0,0,0,0.08)
--border:        #e3e5e8
--border-strong: #c8cbd0
--text:          #1f2328
--text-2:        #4a4d52
--text-3:        #8b8f96
--accent:        #3574f0   (unchanged; *-hover/-press/-soft/-border re-tuned for white)
--green:         #3f9142   (status colors darkened for white-bg contrast)
--red:           #c4453f
--amber:         #b07d18
--shadow-pop:    0 10px 30px rgba(0,0,0,0.16)
--syntax-*:      light variants of the autocomplete icon colors
```

Exact values are validated by running the app in light mode and adjusting.

### Monaco & window background

- `QueryEditor.tsx`: `theme={resolved === 'light' ? 'vs' : 'vs-dark'}`, reading
  `resolved` from the theme context.
- `apps/desktop/src/main/index.ts`: replace `backgroundColor: '#1e1f22'` with the
  resolved-theme background computed at window creation.

### Settings popover UI

- Add a **gear icon button** to the topbar status area (`.topbar-status` in
  `App.tsx`).
- Clicking opens a small popover containing a **segmented control**:
  `Light | Dark | System`, highlighting the current `source`. Selecting a mode
  calls `setSource`.
- The popover is structured so future settings can be added later, but no other
  settings are in scope now.

## Testing

- **Main (vitest):** `theme.json` load/save; default `dark` when missing;
  `nativeTheme.themeSource` is set from the loaded value; resolved-theme helper
  maps source → background color.
- **Renderer:** `ThemeProvider` initializes from `__THEME__`, applies
  `data-theme`, and routes `setSource` through the bridge (mocked).
- **Manual:** switch all three modes; confirm no startup flash in light mode;
  confirm System mode follows an OS appearance change live; confirm Monaco swaps
  between `vs`/`vs-dark`.

## Out of scope (YAGNI)

- Per-theme custom color editing / palette customization.
- Scheduled / time-of-day automatic switching.
- Per-component or per-connection theme overrides.
- Additional settings beyond the theme control in the new popover.

## Affected files (summary)

- `apps/renderer/src/index.css` — token restructure + light palette
- `apps/renderer/src/App.css` — extract `--syntax-*` tokens
- `apps/renderer/src/index.html` — default `data-theme`
- `apps/renderer/src/` — new `ThemeProvider` context + settings popover component;
  wire provider in `App.tsx`; gear button in topbar
- `apps/renderer/src/components/QueryEditor.tsx` — Monaco theme prop
- `apps/desktop/src/main/index.ts` — load/persist theme, `nativeTheme`,
  window `backgroundColor`, `additionalArguments`, IPC handlers + broadcast
- `apps/desktop/src/preload/index.ts` — `__THEME__` + `getTheme`/`setThemeSource`/`onThemeUpdated`
- New small main module for theme persistence (`theme.json`) + its test
