import { describe, it, expect } from 'vitest';
import { NARRATION_PURPOSES, buildNarrationPrompt, deterministicNarration } from './resultNarration';

const input = {
  sql: 'SELECT phone, COUNT(*) c FROM User GROUP BY phone',
  columns: ['phone', 'c'],
  rows: [['010-1', 3], ['010-2', 2]],
  rowCount: 2,
};

describe('resultNarration', () => {
  it('exposes 5 purposes with labels', () => {
    const ids = NARRATION_PURPOSES.map((p) => p.id);
    expect(ids).toEqual(['jira', 'slack', 'cs', 'dev', 'customer']);
    for (const p of NARRATION_PURPOSES) expect(p.label.length).toBeGreaterThan(0);
  });

  it('builds a system+user prompt embedding sql, columns, rows and total count', () => {
    const { system, user } = buildNarrationPrompt('jira', input);
    expect(system.toLowerCase()).toContain('jira');
    expect(system).toMatch(/제공된|결과|데이터/);
    expect(user).toContain('SELECT phone');
    expect(user).toContain('phone');
    expect(user).toContain('010-1');
    expect(user).toContain('2');
  });

  it('each purpose yields a distinct system prompt', () => {
    const systems = NARRATION_PURPOSES.map((p) => buildNarrationPrompt(p.id, input).system);
    expect(new Set(systems).size).toBe(systems.length);
  });

  it('deterministic fallback maps purpose to a format and includes the row count', () => {
    expect(deterministicNarration('jira', input)).toContain('#');
    expect(deterministicNarration('slack', input)).toContain('*');
    expect(deterministicNarration('cs', input)).toContain('2');
  });
});
