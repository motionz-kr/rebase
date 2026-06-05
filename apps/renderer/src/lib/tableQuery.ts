import { quoteIdent, type Driver } from './ddlBuilder';

export interface ColFilter {
  col: string;
  value: string;
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

export function buildWhere(driver: Driver, filters: ColFilter[]): string {
  const active = filters.filter((f) => f.value.trim() !== '');
  if (active.length === 0) return '';
  const conds = active.map(
    (f) => `${quoteIdent(driver, f.col)} LIKE ${likeLiteral(f.value.trim())} ESCAPE '!'`
  );
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
