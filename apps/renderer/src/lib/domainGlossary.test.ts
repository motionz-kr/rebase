import { describe, it, expect } from 'vitest';
import { mergeSchema, serializeGlossary, parseGlossary, type DomainEntry } from './domainGlossary';

describe('parseGlossary', () => {
  it('parses valid JSON', () => {
    const j = '[{"kind":"table","table":"User","column":"","meaning":"환자"}]';
    expect(parseGlossary(j)).toHaveLength(1);
  });
  it('returns [] for empty/invalid/undefined', () => {
    expect(parseGlossary(undefined)).toEqual([]);
    expect(parseGlossary('')).toEqual([]);
    expect(parseGlossary('nonsense')).toEqual([]);
  });
});

describe('serializeGlossary', () => {
  it('drops entries with blank meaning then JSON-stringifies', () => {
    const entries: DomainEntry[] = [
      { kind: 'table', table: 'User', column: '', meaning: '환자' },
      { kind: 'column', table: 'User', column: 'id', meaning: '' },
    ];
    const out = JSON.parse(serializeGlossary(entries));
    expect(out).toHaveLength(1);
    expect(out[0].meaning).toBe('환자');
  });
});

describe('mergeSchema', () => {
  it('seeds table+column rows, preserving existing meanings', () => {
    const existing: DomainEntry[] = [{ kind: 'table', table: 'User', column: '', meaning: '환자' }];
    const merged = mergeSchema(existing, ['User'], { User: ['id', 'hospitalId'] });
    expect(merged).toHaveLength(3);
    const tableRow = merged.find((e) => e.kind === 'table' && e.table === 'User');
    expect(tableRow?.meaning).toBe('환자');
    const colRow = merged.find((e) => e.kind === 'column' && e.column === 'hospitalId');
    expect(colRow?.meaning).toBe('');
  });
  it('keeps orphaned entries that still have a meaning', () => {
    const existing: DomainEntry[] = [{ kind: 'column', table: 'Old', column: 'gone', meaning: '의미있음' }];
    const merged = mergeSchema(existing, ['User'], { User: ['id'] });
    expect(merged.find((e) => e.column === 'gone')?.meaning).toBe('의미있음');
  });
  it('drops orphaned entries with no meaning', () => {
    const existing: DomainEntry[] = [{ kind: 'column', table: 'Old', column: 'gone', meaning: '' }];
    const merged = mergeSchema(existing, ['User'], { User: ['id'] });
    expect(merged.find((e) => e.column === 'gone')).toBeUndefined();
  });
});
