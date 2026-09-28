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

function withoutSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, ' ')
    .replace(/--[^\r\n]*(?:\r?\n|$)/g, ' ')
    .replace(/#[^\r\n]*(?:\r?\n|$)/g, ' ');
}

function isCommentOnly(sql: string): boolean {
  return withoutSqlComments(sql).trim() === '';
}

function isTrailingTrivia(sql: string): boolean {
  return withoutSqlComments(sql).replace(/;/g, '').trim() === '';
}

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

  const ranges = splitStatementRanges(sql);
  const rangeIndex = ranges.findIndex(
    (statement) => cursorOffset >= statement.start && cursorOffset <= statement.end
  );
  if (rangeIndex >= 0 && !isCommentOnly(ranges[rangeIndex].statement)) {
    const range = ranges[rangeIndex];
    return { sql: range.statement, ranges: [range] };
  }

  // Statement ranges exclude terminators and may include a trailing comment as
  // its own range. Keep the last real statement runnable from that tail, while
  // leaving gaps between statements intentionally idle.
  const last = [...ranges].reverse().find((statement) => !isCommentOnly(statement.statement));
  if (last && cursorOffset > last.end && isTrailingTrivia(sql.slice(last.end, cursorOffset))) {
    return { sql: last.statement, ranges: [last] };
  }

  return null;
}
