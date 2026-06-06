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
