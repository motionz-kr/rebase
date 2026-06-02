import type { CellValue } from './dmlBuilder';

export type CellCategory = 'number' | 'boolean' | 'string';

const NUMBER_TYPES = new Set([
  'int', 'integer', 'smallint', 'mediumint', 'bigint', 'tinyint',
  'decimal', 'numeric', 'dec', 'fixed', 'float', 'double', 'real',
  'serial', 'bigserial', 'smallserial',
]);
const BOOLEAN_TYPES = new Set(['bool', 'boolean']);

// Map a SQL column type to a value category. Strips size/precision params and
// normalizes case. Dates/JSON/text/etc fall through to 'string' (quoted in SQL).
export function classifyColumnType(sqlType: string): CellCategory {
  const base = sqlType.toLowerCase().split('(')[0].trim();
  const head = base.split(/\s+/)[0]; // e.g. "double precision" -> "double"
  if (NUMBER_TYPES.has(head)) return 'number';
  if (BOOLEAN_TYPES.has(head)) return 'boolean';
  return 'string';
}

// Coerce the user's edited text into a typed CellValue for the column category.
// NULL is set separately (via the editor's NULL button), not here.
export function coerceCellValue(category: CellCategory, text: string): CellValue {
  if (category === 'number') {
    const t = text.trim();
    if (t !== '' && Number.isFinite(Number(t))) return Number(t);
    return text;
  }
  if (category === 'boolean') {
    const t = text.trim().toLowerCase();
    if (t === 'true' || t === '1' || t === 't' || t === 'yes') return true;
    if (t === 'false' || t === '0' || t === 'f' || t === 'no') return false;
    return text;
  }
  return text;
}
