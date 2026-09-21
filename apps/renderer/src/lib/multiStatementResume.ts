import type { SqlStatementRange } from './splitStatements';

export interface MultiStatementResumePlan {
  ranges: SqlStatementRange[];
  startIndex: number;
  statements: string[];
}

/**
 * Creates the continuation plan for a multi-statement run that was stopped by
 * a policy prompt or an execution error. The original ranges are retained so
 * editor decorations still point at the same source offsets, while statements
 * before startIndex are deliberately excluded from the next execution pass.
 */
export function createMultiStatementResumePlan(
  ranges: SqlStatementRange[],
  startIndex: number,
): MultiStatementResumePlan | null {
  const normalizedIndex = Math.trunc(startIndex);
  if (!Number.isInteger(startIndex) || ranges.length < 2 || normalizedIndex < 0 || normalizedIndex >= ranges.length) return null;
  return {
    ranges,
    startIndex: normalizedIndex,
    statements: ranges.slice(normalizedIndex).map((range) => range.statement),
  };
}
