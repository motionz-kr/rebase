import type { AnalyzeResult } from '../global';

export type RiskLevel = AnalyzeResult['level'];

export function riskLabel(level: RiskLevel): string {
  switch (level) {
    case 'high': return '위험';
    case 'medium': return '주의';
    case 'warn': return '경고';
    default: return '안전';
  }
}

export function riskClass(level: RiskLevel): string {
  return `risk-${level}`;
}

// requiresAcknowledgement is true when a safe-mode connection must force the
// user through an explicit "강제 실행" step (high risk only).
export function requiresAcknowledgement(r: AnalyzeResult, safeMode: boolean): boolean {
  return safeMode && r.level === 'high';
}

export interface RiskView {
  level: RiskLevel;
  label: string;
  verb: string;
  table: string;
  reasons: string[];
  affectedText: string;
  tenantMissing: boolean;
  previewSql: string;
  previewCols: string[];
  previewRows: any[][];
  hasRollback: boolean;
  rollbackSql: string;
  rollbackNote: string;
}

export function toRiskView(r: AnalyzeResult): RiskView {
  const affectedText = r.affectedRows == null
    ? '알 수 없음'
    : `${r.affectedRows.toLocaleString()}건`;
  return {
    level: r.level,
    label: riskLabel(r.level),
    verb: r.verb,
    table: r.table,
    reasons: r.reasons ?? [],
    affectedText,
    tenantMissing: r.tenantMissing,
    previewSql: r.previewSql ?? '',
    previewCols: r.previewCols ?? [],
    previewRows: r.previewRows ?? [],
    hasRollback: !!r.rollbackSql,
    rollbackSql: r.rollbackSql ?? '',
    rollbackNote: r.rollbackNote ?? '',
  };
}
