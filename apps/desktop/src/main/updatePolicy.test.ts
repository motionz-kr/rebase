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
