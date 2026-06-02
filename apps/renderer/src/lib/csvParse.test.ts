import { describe, it, expect } from 'vitest';
import { parseCsv } from './csvParse';

describe('parseCsv', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b\n1,2\n3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });
  it('handles quoted fields with commas, quotes, and newlines', () => {
    expect(parseCsv('x\n"a,b"\n"he said ""hi"""\n"line\nbreak"')).toEqual([
      ['x'], ['a,b'], ['he said "hi"'], ['line\nbreak'],
    ]);
  });
  it('handles CRLF and a trailing newline without an extra empty row', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('keeps empty fields', () => {
    expect(parseCsv('a,b,c\n1,,3')).toEqual([['a', 'b', 'c'], ['1', '', '3']]);
  });
  it('returns [] for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });
});
