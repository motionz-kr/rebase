import { describe, it, expect } from 'vitest';
import { flattenDocument, columnsFor, formatExtJson, documentsToCsv } from './mongoDoc';

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

describe('documentsToCsv', () => {
  it('builds a CSV with the column union as header and one row per doc', () => {
    const csv = documentsToCsv(['{"_id":1,"name":"Ann"}', '{"_id":2,"name":"Bob","age":3}']);
    expect(csv).toBe('_id,name,age\n1,Ann,\n2,Bob,3');
  });
  it('leaves missing fields empty and quotes values needing escaping', () => {
    const csv = documentsToCsv(['{"a":"x,y","b":1}', '{"a":"z"}']);
    expect(csv).toBe('a,b\n"x,y",1\nz,');
  });
  it('serializes nested objects/arrays as compact JSON cells', () => {
    expect(documentsToCsv([DOC])).toBe(
      '_id,name,tags,meta\n"{""$oid"":""abc""}",Ann,"[""a"",""b""]","{""x"":1}"',
    );
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
