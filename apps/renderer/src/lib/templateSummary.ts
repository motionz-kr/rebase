export interface Summary {
  title: string;
  rowCount: number;
  columns: string[];
  lines: string[]; // up to 5 sample lines, "col=val, col=val"
}

export type SummaryFormat = 'plain' | 'slack' | 'jira';

export function buildSummary(title: string, columns: string[], rows: unknown[][]): Summary {
  const lines = rows.slice(0, 5).map((r) =>
    columns.map((c, i) => `${c}=${r[i] == null ? 'NULL' : String(r[i])}`).join(', '),
  );
  return { title, rowCount: rows.length, columns, lines };
}

export function formatSummary(s: Summary, fmt: SummaryFormat): string {
  const head = s.rowCount === 0 ? `결과 없음 (0행)` : `총 ${s.rowCount.toLocaleString()}행`;
  if (fmt === 'slack') {
    const body = s.lines.map((l) => `• ${l}`).join('\n');
    return `*${s.title}*\n${head}${body ? '\n' + body : ''}`;
  }
  if (fmt === 'jira') {
    // Jira wiki markup: h3. heading + '# ' numbered list (contains '#').
    const body = s.lines.map((l) => `# ${l}`).join('\n');
    return `h3. ${s.title}\n${head}${body ? '\n' + body : ''}`;
  }
  const body = s.lines.map((l) => `- ${l}`).join('\n');
  return `${s.title}\n${head}${body ? '\n' + body : ''}`;
}
