import { quoteIdent, type Driver } from './ddlBuilder';
import { classifyColumnType } from './cellTypes';

export type FilterOperator =
  | 'contains'
  | 'equals'
  | 'not-equals'
  | 'starts-with'
  | 'ends-with'
  | 'greater-than'
  | 'greater-or-equal'
  | 'less-than'
  | 'less-or-equal'
  | 'is-null'
  | 'is-not-null';

export const FILTER_OPERATOR_LABELS: Record<FilterOperator, string> = {
  contains: '포함',
  equals: '같음',
  'not-equals': '같지 않음',
  'starts-with': '시작',
  'ends-with': '끝',
  'greater-than': '>',
  'greater-or-equal': '≥',
  'less-than': '<',
  'less-or-equal': '≤',
  'is-null': 'NULL',
  'is-not-null': 'NOT NULL',
};

export interface ColFilter {
  col: string;
  value: string;
  operator?: FilterOperator;
}
export interface OrderBy {
  col: string;
  dir: 'asc' | 'desc';
}
export interface PageQuery {
  filters?: ColFilter[];
  orderBy?: OrderBy | null;
  limit: number;
  offset: number;
}

// Build a single-quoted LIKE pattern `'%value%'`, escaping the string-literal
// quote and the LIKE wildcards (% and _) so the value is matched literally as a
// substring. Pair with `ESCAPE '!'`. We use `!` (not `\`) as the LIKE escape
// char because MySQL treats backslash as a string-literal escape, so `ESCAPE '\'`
// is an unterminated literal; `!` is a plain character in both MySQL and Postgres.
function likeLiteral(value: string): string {
  const esc = value
    .replace(/!/g, '!!')
    .replace(/%/g, '!%')
    .replace(/_/g, '!_')
    .replace(/'/g, "''");
  return `'%${esc}%'`;
}

function likePattern(value: string, operator: FilterOperator): string {
  const escaped = value.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_').replace(/'/g, "''");
  const pattern = operator === 'starts-with' ? `${escaped}%` : operator === 'ends-with' ? `%${escaped}` : `%${escaped}%`;
  return `'${pattern}'`;
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function filterOperatorsForType(sqlType: string): FilterOperator[] {
  const normalized = sqlType.toLowerCase().trim();
  const hasNullChecks: FilterOperator[] = ['is-null', 'is-not-null'];
  const equality: FilterOperator[] = ['equals', 'not-equals'];

  if (/\b(bool|boolean|bit)\b/.test(normalized)) return [...equality, ...hasNullChecks];
  if (classifyColumnType(normalized) === 'number' || /\b(date|time|year)\b/.test(normalized)) {
    return [...equality, 'greater-than', 'greater-or-equal', 'less-than', 'less-or-equal', ...hasNullChecks];
  }
  if (/(char|text|clob|citext|enum)/.test(normalized)) {
    return ['contains', ...equality, 'starts-with', 'ends-with', ...hasNullChecks];
  }
  return [...equality, ...hasNullChecks];
}

export function defaultFilterOperator(sqlType: string): FilterOperator {
  return filterOperatorsForType(sqlType)[0] ?? 'equals';
}

export function filterOperatorRequiresValue(operator: FilterOperator): boolean {
  return operator !== 'is-null' && operator !== 'is-not-null';
}

export function buildWhere(driver: Driver, filters: ColFilter[]): string {
  const active = filters.filter((f) => !filterOperatorRequiresValue(f.operator ?? 'contains') || f.value.trim() !== '');
  if (active.length === 0) return '';
  const conds = active.map((f) => {
    const col = quoteIdent(driver, f.col);
    const operator = f.operator ?? 'contains';
    const value = f.value.trim();
    if (operator === 'is-null') return `${col} IS NULL`;
    if (operator === 'is-not-null') return `${col} IS NOT NULL`;
    if (operator === 'contains' || operator === 'starts-with' || operator === 'ends-with') {
      return `${col} LIKE ${operator === 'contains' ? likeLiteral(value) : likePattern(value, operator)} ESCAPE '!'`;
    }

    const sqlOperator: Record<Extract<FilterOperator, 'equals' | 'not-equals' | 'greater-than' | 'greater-or-equal' | 'less-than' | 'less-or-equal'>, string> = {
      equals: '=',
      'not-equals': '<>',
      'greater-than': '>',
      'greater-or-equal': '>=',
      'less-than': '<',
      'less-or-equal': '<=',
    };
    return `${col} ${sqlOperator[operator]} ${sqlLiteral(value)}`;
  });
  return 'WHERE ' + conds.join(' AND ');
}

export function buildSelectPage(driver: Driver, table: string, q: PageQuery): string {
  const parts = [`SELECT * FROM ${quoteIdent(driver, table)}`];
  const where = buildWhere(driver, q.filters ?? []);
  if (where) parts.push(where);
  const orderBy = q.orderBy
    ? `${quoteIdent(driver, q.orderBy.col)} ${q.orderBy.dir === 'asc' ? 'ASC' : 'DESC'}`
    : null;
  if (driver === 'sqlserver') {
    // T-SQL has no LIMIT/OFFSET; paginate with OFFSET ... FETCH, which requires
    // an ORDER BY. When the caller has no explicit order, use a stable no-op.
    parts.push(`ORDER BY ${orderBy ?? '(SELECT NULL)'}`);
    parts.push(`OFFSET ${q.offset} ROWS FETCH NEXT ${q.limit} ROWS ONLY`);
    return parts.join(' ');
  }
  if (orderBy) parts.push(`ORDER BY ${orderBy}`);
  parts.push(`LIMIT ${q.limit} OFFSET ${q.offset}`);
  return parts.join(' ');
}
