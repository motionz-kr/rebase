import { quoteIdent, type Driver } from './ddlBuilder';

export type CellValue = string | number | boolean | null;

export interface ColValue {
  col: string;
  value: CellValue;
}

// Render a value as a SQL literal, dialect-aware. Strings are single-quoted with
// the quote doubled; MySQL also escapes backslash (it treats \ as a string-literal
// escape), Postgres (standard_conforming_strings) does not.
export function sqlLiteral(driver: Driver, value: CellValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return (driver === 'mysql' || driver === 'sqlite') ? (value ? '1' : '0') : value ? 'TRUE' : 'FALSE';
  let s = value.replace(/'/g, "''");
  if (driver === 'mysql') s = s.replace(/\\/g, '\\\\');
  return `'${s}'`;
}

export function buildUpdate(driver: Driver, table: string, pk: ColValue[], changes: ColValue[]): string {
  const set = changes.map((c) => `${quoteIdent(driver, c.col)} = ${sqlLiteral(driver, c.value)}`).join(', ');
  const where = pk.map((c) => `${quoteIdent(driver, c.col)} = ${sqlLiteral(driver, c.value)}`).join(' AND ');
  return `UPDATE ${quoteIdent(driver, table)} SET ${set} WHERE ${where}`;
}

export function buildInsert(driver: Driver, table: string, cols: ColValue[]): string {
  const names = cols.map((c) => quoteIdent(driver, c.col)).join(', ');
  const vals = cols.map((c) => sqlLiteral(driver, c.value)).join(', ');
  return `INSERT INTO ${quoteIdent(driver, table)} (${names}) VALUES (${vals})`;
}

export function buildDelete(driver: Driver, table: string, pk: ColValue[]): string {
  const where = pk.map((c) => `${quoteIdent(driver, c.col)} = ${sqlLiteral(driver, c.value)}`).join(' AND ');
  return `DELETE FROM ${quoteIdent(driver, table)} WHERE ${where}`;
}

// Build a single multi-row INSERT. Column names are plain strings; values are
// CellValue tuples rendered via sqlLiteral (number/boolean unquoted, null → NULL).
export function buildMultiInsert(driver: Driver, table: string, cols: string[], rows: CellValue[][]): string {
  const names = cols.map((c) => quoteIdent(driver, c)).join(', ');
  const tuples = rows.map((r) => '(' + r.map((v) => sqlLiteral(driver, v)).join(', ') + ')').join(', ');
  return `INSERT INTO ${quoteIdent(driver, table)} (${names}) VALUES ${tuples}`;
}
