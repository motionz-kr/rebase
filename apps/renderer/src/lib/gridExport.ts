// Pure serializers for exporting / copying grid data. No DOM dependency.

function cell(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object') return JSON.stringify(val);
  return String(val);
}

// RFC4180-style field: quote when it contains comma, quote, CR or LF.
function csvField(val: unknown): string {
  const s = cell(val);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  const head = columns.map(csvField).join(',');
  const body = rows.map((r) => r.map(csvField).join(',')).join('\n');
  return body ? head + '\n' + body : head;
}

export function toJson(columns: string[], rows: unknown[][]): string {
  const objs = rows.map((r) => {
    const o: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      o[c] = r[i] === undefined ? null : r[i];
    });
    return o;
  });
  return JSON.stringify(objs, null, 2);
}

// Tab-separated values for clipboard (Excel/Sheets friendly). null → empty.
export function toTsv(grid: unknown[][]): string {
  return grid.map((row) => row.map(cell).join('\t')).join('\n');
}
