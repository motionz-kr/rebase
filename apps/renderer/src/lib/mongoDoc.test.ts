import { describe, it, expect } from 'vitest';
import { flattenDocument, columnsFor, formatExtJson } from './mongoDoc';

const DOC = '{"_id":{"$oid":"abc"},"name":"Ann","tags":["a","b"],"meta":{"x":1}}';

describe('flattenDocument', () => {
  it('maps top-level fields to grid cells', () => {
    expect(flattenDocument(DOC)).toEqual({
      _id: '{"$oid":"abc"}',
      name: 'Ann',
      tags: '["a","b"]',
      meta: '{"x":1}',
    });
  });
  it('stringifies scalar types', () => {
    expect(flattenDocument('{"n":1,"b":true,"z":null}')).toEqual({
      n: '1',
      b: 'true',
      z: 'null',
    });
  });
  it('returns empty object for unparseable input', () => {
    expect(flattenDocument('not json')).toEqual({});
  });
});

describe('columnsFor', () => {
  it('returns union of top-level keys in first-seen order', () => {
    expect(columnsFor([DOC])).toEqual(['_id', 'name', 'tags', 'meta']);
  });
  it('puts _id first when present', () => {
    expect(columnsFor(['{"name":"Ann","_id":1}', '{"name":"Bob","age":2}'])).toEqual([
      '_id', 'name', 'age',
    ]);
  });
  it('ignores unparseable docs', () => {
    expect(columnsFor(['not json', '{"a":1}'])).toEqual(['a']);
  });
});

describe('formatExtJson', () => {
  it('pretty-prints a doc', () => {
    expect(formatExtJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  });
  it('returns input unchanged when it cannot parse', () => {
    expect(formatExtJson('not json')).toBe('not json');
  });
});
