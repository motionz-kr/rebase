import { splitStatementRanges, type SqlStatementRange } from './splitStatements';

export interface SqlExecutionTarget {
  /** Exact SQL sent to the query runner. */
  sql: string;
  /** Statement ranges translated back to offsets in the full editor model. */
  ranges: SqlStatementRange[];
}

export interface SqlCaretSelection {
  cursorOffset: number;
  selectionStart?: number;
  selectionEnd?: number;
}

const clampOffset = (offset: number, length: number): number => Math.min(Math.max(offset, 0), length);

/**
 * Resolve Cmd/Ctrl+Enter's execution target. A non-empty selection takes
 * precedence; otherwise only the statement containing the caret is returned.
 * An empty position between statements is deliberately not treated as Run All.
 */
export function resolveSqlExecutionTarget(sql: string, position: SqlCaretSelection): SqlExecutionTarget | null {
  if (!sql) return null;

  const cursorOffset = clampOffset(position.cursorOffset, sql.length);
  const rawSelectionStart = position.selectionStart;
  const rawSelectionEnd = position.selectionEnd;
  if (rawSelectionStart !== undefined && rawSelectionEnd !== undefined && rawSelectionStart !== rawSelectionEnd) {
    const start = clampOffset(Math.min(rawSelectionStart, rawSelectionEnd), sql.length);
    const end = clampOffset(Math.max(rawSelectionStart, rawSelectionEnd), sql.length);
    const selectedSql = sql.slice(start, end);
    const ranges = splitStatementRanges(selectedSql).map((range) => ({
      ...range,
      start: range.start + start,
      end: range.end + start,
    }));
    return ranges.length > 0 ? { sql: selectedSql, ranges } : null;
  }

  const range = splitStatementRanges(sql).find(
    (statement) => cursorOffset >= statement.start && cursorOffset <= statement.end
  );
  return range ? { sql: range.statement, ranges: [range] } : null;
}
