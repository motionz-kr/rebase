import { describe, it, expect } from 'vitest';
import { clampSidebarWidth, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX } from './uiPrefs';

describe('clampSidebarWidth', () => {
  it('clamps below min and above max', () => {
    expect(clampSidebarWidth(50)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_MAX);
  });
  it('passes through an in-range value, rounded', () => {
    expect(clampSidebarWidth(312.6)).toBe(313);
  });
  it('falls back to default for NaN', () => {
    expect(clampSidebarWidth(NaN)).toBe(SIDEBAR_DEFAULT);
  });
});
