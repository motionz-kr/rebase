import { describe, it, expect } from 'vitest';
import { classifyColumnType, coerceCellValue } from './cellTypes';

describe('classifyColumnType', () => {
  it('classifies number types (case-insensitive, with params)', () => {
    for (const t of ['int', 'INT', 'integer', 'bigint', 'smallint', 'tinyint', 'decimal(10,2)', 'numeric', 'float', 'double', 'double precision', 'real', 'serial', 'bigserial']) {
      expect(classifyColumnType(t)).toBe('number');
    }
  });
  it('classifies boolean types', () => {
    expect(classifyColumnType('bool')).toBe('boolean');
    expect(classifyColumnType('boolean')).toBe('boolean');
  });
  it('classifies everything else as string', () => {
    for (const t of ['varchar(80)', 'char(2)', 'text', 'date', 'datetime', 'timestamp without time zone', 'time', 'json', 'jsonb', 'uuid', 'bytea']) {
      expect(classifyColumnType(t)).toBe('string');
    }
  });
});

describe('coerceCellValue', () => {
  it('coerces valid numbers, passes invalid/empty through as string', () => {
    expect(coerceCellValue('number', '5')).toBe(5);
    expect(coerceCellValue('number', ' 3.14 ')).toBe(3.14);
    expect(coerceCellValue('number', '-2')).toBe(-2);
    expect(coerceCellValue('number', 'abc')).toBe('abc');
    expect(coerceCellValue('number', '')).toBe('');
  });
  it('coerces boolean variants', () => {
    expect(coerceCellValue('boolean', 'true')).toBe(true);
    expect(coerceCellValue('boolean', '1')).toBe(true);
    expect(coerceCellValue('boolean', 'T')).toBe(true);
    expect(coerceCellValue('boolean', 'false')).toBe(false);
    expect(coerceCellValue('boolean', '0')).toBe(false);
    expect(coerceCellValue('boolean', 'maybe')).toBe('maybe');
  });
  it('passes strings through (including empty)', () => {
    expect(coerceCellValue('string', 'hi')).toBe('hi');
    expect(coerceCellValue('string', '')).toBe('');
  });
});
