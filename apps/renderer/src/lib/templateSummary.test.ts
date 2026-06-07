import { describe, it, expect } from 'vitest';
import { buildSummary, formatSummary } from './templateSummary';

const cols = ['phone', 'duplicateCount'];
const rows = [['010-1', 3], ['010-2', 2]];

describe('templateSummary', () => {
  it('builds a deterministic summary with row count and top rows', () => {
    const s = buildSummary('phone 중복 조회', cols, rows);
    expect(s.title).toBe('phone 중복 조회');
    expect(s.rowCount).toBe(2);
    expect(s.lines.length).toBeGreaterThan(0);
  });

  it('formats plain / slack / jira', () => {
    const s = buildSummary('T', cols, rows);
    expect(formatSummary(s, 'plain')).toContain('2');
    expect(formatSummary(s, 'slack')).toContain('*');
    expect(formatSummary(s, 'jira')).toContain('#');
  });

  it('handles empty result', () => {
    const s = buildSummary('T', cols, []);
    expect(s.rowCount).toBe(0);
    expect(formatSummary(s, 'plain')).toMatch(/0|없/);
  });
});
