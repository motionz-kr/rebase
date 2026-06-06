import { describe, it, expect } from 'vitest';
import { toRiskView, requiresAcknowledgement, riskLabel } from './safeMode';
import type { AnalyzeResult } from '../global';

const base: AnalyzeResult = {
  level: 'high', verb: 'DELETE', reasons: ['no where'], table: 'User',
  hasWhere: false, tenantMissing: false, parseable: true,
  affectedRows: 5, previewSql: 'SELECT * FROM `User`', previewCols: ['id'],
  previewRows: [[1]], rollbackSql: 'INSERT ...', rollbackNote: '',
};

describe('safeMode', () => {
  it('requires acknowledgement for high risk in safe mode', () => {
    expect(requiresAcknowledgement(base, true)).toBe(true);
    expect(requiresAcknowledgement(base, false)).toBe(false);
    expect(requiresAcknowledgement({ ...base, level: 'medium' }, true)).toBe(false);
  });

  it('maps level to a Korean label', () => {
    expect(riskLabel('high')).toContain('위험');
    expect(riskLabel('safe')).toContain('안전');
  });

  it('builds a view with affected-row text', () => {
    const v = toRiskView(base);
    expect(v.affectedText).toContain('5');
    expect(v.hasRollback).toBe(true);
  });

  it('handles null affected rows', () => {
    const v = toRiskView({ ...base, affectedRows: null });
    expect(v.affectedText).toMatch(/알 수 없|—|N\/A/);
  });
});
