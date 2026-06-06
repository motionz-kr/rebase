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
