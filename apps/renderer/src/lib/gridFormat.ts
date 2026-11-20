// Shared grid display/export helpers used by ResultGrid and TableDataView.

// How a cell value is shown in the grid (NULL for empty, JSON for objects).
export function cellText(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

// Timestamp for export filenames: YYYYMMDD-HHMMSS. Date is injectable for tests.
export function tsTimestamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export const UTF8_BOM = '\uFEFF';

// Excel opens a BOM-less UTF-8 CSV as the system code page (Korean text turns into
// mojibake). The BOM is added at save time only; toCsv() output stays pure.
export function withExportBom(text: string, mime: string): string {
  if (!/^text\/csv\b/i.test(mime) || text.startsWith(UTF8_BOM)) return text;
  return UTF8_BOM + text;
}

// Trigger a browser download of `text` as `filename`. CSV gets a UTF-8 BOM here.
export function download(filename: string, text: string, mime: string): void {
  const blob = new Blob([withExportBom(text, mime)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
