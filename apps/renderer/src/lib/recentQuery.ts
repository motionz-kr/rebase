import { quoteIdent, type Driver } from './ddlBuilder';

// Build a one-click "most recently added rows" query. Recency is approximated by
// ordering on the primary key descending (auto-increment / sequence tables get
// the newest rows first); without a known single-column PK, falls back to an
// unordered LIMIT.
export function buildRecentRowsQuery(driver: Driver, table: string, pkColumn: string | null, limit = 500): string {
  const t = quoteIdent(driver, table);
  if (driver === 'sqlserver') {
    // T-SQL has no LIMIT; use TOP n.
    return pkColumn
      ? `SELECT TOP ${limit} * FROM ${t} ORDER BY ${quoteIdent(driver, pkColumn)} DESC`
      : `SELECT TOP ${limit} * FROM ${t}`;
  }
  if (pkColumn) {
    return `SELECT * FROM ${t} ORDER BY ${quoteIdent(driver, pkColumn)} DESC LIMIT ${limit}`;
  }
  return `SELECT * FROM ${t} LIMIT ${limit}`;
}
