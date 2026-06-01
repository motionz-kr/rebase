import { describe, it, expect } from 'vitest';
import { cellText, tsTimestamp } from './gridFormat';

describe('cellText', () => {
  it('renders null/undefined as NULL', () => {
    expect(cellText(null)).toBe('NULL');
    expect(cellText(undefined)).toBe('NULL');
  });
  it('stringifies objects as JSON and primitives directly', () => {
    expect(cellText({ a: 1 })).toBe('{"a":1}');
    expect(cellText(42)).toBe('42');
    expect(cellText('hi')).toBe('hi');
  });
});

describe('tsTimestamp', () => {
  it('formats a fixed date as YYYYMMDD-HHMMSS', () => {
    expect(tsTimestamp(new Date(2026, 5, 1, 9, 7, 3))).toBe('20260601-090703');
  });
});
