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
