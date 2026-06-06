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
