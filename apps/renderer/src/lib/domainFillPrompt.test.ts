import { describe, it, expect } from 'vitest';
import { buildFillPrompt, parseFillResponse } from './domainFillPrompt';

describe('buildFillPrompt', () => {
  it('includes schema names and asks for JSON; appends user text', () => {
    const { system, user } = buildFillPrompt(['User'], { User: ['id', 'hospitalId'] }, 'User는 환자');
    expect(system).toMatch(/JSON/);
    expect(user).toContain('User');
    expect(user).toContain('hospitalId');
    expect(user).toContain('User는 환자');
  });
  it('works without user text', () => {
    const { user } = buildFillPrompt(['User'], { User: ['id'] });
    expect(user).toContain('User');
  });
});

describe('parseFillResponse', () => {
  it('extracts entries from a JSON array, even with surrounding prose/fences', () => {
    const text = '여기 있습니다:\n```json\n[{"kind":"table","table":"User","column":"","meaning":"환자"}]\n```';
    const out = parseFillResponse(text);
    expect(out).toHaveLength(1);
    expect(out[0].meaning).toBe('환자');
  });
  it('returns [] when no JSON array present', () => {
    expect(parseFillResponse('죄송합니다 모르겠어요')).toEqual([]);
  });
});
