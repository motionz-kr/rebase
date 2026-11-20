import { describe, it, expect } from 'vitest';
import { cellText, tsTimestamp, withExportBom, UTF8_BOM } from './gridFormat';

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

describe('withExportBom', () => {
  it('prefixes CSV with a UTF-8 BOM so Excel reads Korean text', () => {
    expect(withExportBom('이름\n홍길동', 'text/csv')).toBe(UTF8_BOM + '이름\n홍길동');
    expect(withExportBom('a', 'text/csv;charset=utf-8')).toBe(UTF8_BOM + 'a');
  });
  it('is idempotent and leaves other formats alone', () => {
    expect(withExportBom(UTF8_BOM + 'a', 'text/csv')).toBe(UTF8_BOM + 'a');
    expect(withExportBom('[]', 'application/json')).toBe('[]');
    expect(withExportBom('x', 'text/plain')).toBe('x');
  });
});
