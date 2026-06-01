import { describe, it, expect } from 'vitest';
import { toCsv, toJson, toTsv } from './gridExport';

describe('toCsv', () => {
  it('joins columns and rows with commas and newlines', () => {
    expect(toCsv(['a', 'b'], [[1, 2], [3, 4]])).toBe('a,b\n1,2\n3,4');
  });
  it('quotes fields containing comma, quote, or newline and doubles quotes', () => {
    expect(toCsv(['x'], [['a,b'], ['he said "hi"'], ['line\nbreak']])).toBe(
      'x\n"a,b"\n"he said ""hi"""\n"line\nbreak"'
    );
  });
  it('renders null as empty and objects as JSON', () => {
    expect(toCsv(['a', 'b'], [[null, { k: 1 }]])).toBe('a,b\n,"{""k"":1}"');
  });
  it('returns just the header when there are no rows', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b');
  });
});

describe('toJson', () => {
  it('maps rows to column-keyed objects', () => {
    expect(toJson(['id', 'name'], [[1, 'x'], [2, 'y']])).toBe(
      JSON.stringify([{ id: 1, name: 'x' }, { id: 2, name: 'y' }], null, 2)
    );
  });
  it('preserves null values', () => {
    expect(toJson(['a'], [[null]])).toBe(JSON.stringify([{ a: null }], null, 2));
  });
});

describe('toTsv', () => {
  it('joins a subgrid with tabs and newlines, null → empty', () => {
    expect(toTsv([[1, null], ['a', 'b']])).toBe('1\t\na\tb');
  });
});
