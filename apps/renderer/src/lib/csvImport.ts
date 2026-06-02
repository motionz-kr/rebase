import type { Driver } from './ddlBuilder';
import type { CellValue } from './dmlBuilder';
import { buildMultiInsert } from './dmlBuilder';
import { classifyColumnType, coerceCellValue } from './cellTypes';

// Auto-map table columns to CSV header indices by case-insensitive name match.
export function autoMapColumns(tableColumns: string[], csvHeader: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  const lower = csvHeader.map((h) => h.trim().toLowerCase());
  for (const col of tableColumns) {
    const idx = lower.indexOf(col.trim().toLowerCase());
    if (idx >= 0) map[col] = idx;
  }
  return map;
}

export interface ImportSpec {
  table: string;
  mapping: Record<string, number>; // tableColumn -> csv column index
  colTypes: Record<string, string>; // tableColumn -> SQL type (for coercion)
  chunkSize?: number;
}

// Build chunked multi-row INSERT statements from CSV data rows. Empty cell → NULL;
// values coerced by the target column's type. Intended to run in one transaction.
export function buildImportStatements(driver: Driver, spec: ImportSpec, dataRows: string[][]): string[] {
  const cols = Object.keys(spec.mapping);
  if (cols.length === 0 || dataRows.length === 0) return [];
  const chunk = spec.chunkSize && spec.chunkSize > 0 ? spec.chunkSize : 500;
  const toVal = (col: string, raw: string | undefined): CellValue => {
    if (raw === undefined || raw === '') return null;
    return coerceCellValue(classifyColumnType(spec.colTypes[col] ?? ''), raw);
  };
  const stmts: string[] = [];
  for (let i = 0; i < dataRows.length; i += chunk) {
    const slice = dataRows.slice(i, i + chunk);
    const tuples: CellValue[][] = slice.map((r) => cols.map((col) => toVal(col, r[spec.mapping[col]])));
    stmts.push(buildMultiInsert(driver, spec.table, cols, tuples));
  }
  return stmts;
}
