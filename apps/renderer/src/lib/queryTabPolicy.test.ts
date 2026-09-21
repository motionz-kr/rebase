import { describe, expect, it } from 'vitest';
import { canEnableTabWrite, resolveTabWriteMode, resolveQueryAllowWrite } from './queryTabPolicy';

describe('query tab session policy', () => {
  it('keeps write mode independent per tab', () => {
    const tabs = [
      { id: 'tab-a', writeMode: false },
      { id: 'tab-b', writeMode: false },
    ];

    const next = tabs.map((tab) => tab.id === 'tab-a' ? { ...tab, writeMode: true } : tab);

    expect(next).toEqual([
      { id: 'tab-a', writeMode: true },
      { id: 'tab-b', writeMode: false },
    ]);
  });

  it('does not allow a read-only connection to enable write mode', () => {
    expect(canEnableTabWrite(true, true)).toBe(false);
    expect(canEnableTabWrite(true, false)).toBe(true);
    expect(canEnableTabWrite(false, true)).toBe(true);
  });

  it('forces query execution to remain read-only for a read-only connection', () => {
    expect(resolveTabWriteMode(true, true)).toBe(false);
    expect(resolveTabWriteMode(false, true)).toBe(true);
    expect(resolveQueryAllowWrite(true, true, true)).toBe(false);
    expect(resolveQueryAllowWrite(false, false, true)).toBe(true);
    expect(resolveQueryAllowWrite(false, true, false)).toBe(false);
  });
});
