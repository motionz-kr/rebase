import type { SchemaGraph } from '../global';

export type DdlPart = { table: string; ddl: string } | { table: string; error: string };

// Mermaid attribute types must be single tokens: collapse whitespace, drop
// parens/commas. Falls back to "unknown" for empty input.
export function sanitizeMermaidType(type: string): string {
  const t = type.trim().replace(/[(),]/g, '').replace(/\s+/g, '_');
  return t || 'unknown';
}

// Whole-graph Mermaid `erDiagram` text. One block per table (PK columns marked
// `PK`), one `}o--||` relationship per foreign key (label quoted in case the
// column name has odd characters). FKs referencing a missing table are skipped.
export function toMermaid(g: SchemaGraph): string {
  const lines: string[] = ['erDiagram'];
  for (const t of g.tables) {
    lines.push(`  ${t.name} {`);
    for (const c of t.columns) {
      lines.push(`    ${sanitizeMermaidType(c.type)} ${c.name}${c.primaryKey ? ' PK' : ''}`);
    }
    lines.push('  }');
  }
  const names = new Set(g.tables.map((t) => t.name));
  for (const fk of g.foreignKeys) {
    if (!names.has(fk.fromTable) || !names.has(fk.toTable)) continue;
    lines.push(`  ${fk.fromTable} }o--|| ${fk.toTable} : "${fk.fromColumn}"`);
  }
  return lines.join('\n') + '\n';
}

// DBML (dbdiagram.io). One `Table` block per table (PK columns marked `[pk]`),
// one `Ref:` per foreign key. Types containing whitespace are quoted.
export function toDbml(g: SchemaGraph): string {
  const dbmlType = (t: string) => (/\s/.test(t) ? `"${t}"` : t);
  const blocks = g.tables.map((t) => {
    const cols = t.columns.map((c) => `  ${c.name} ${dbmlType(c.type)}${c.primaryKey ? ' [pk]' : ''}`);
    return `Table ${t.name} {\n${cols.join('\n')}\n}`;
  });
  const names = new Set(g.tables.map((t) => t.name));
  const refs = g.foreignKeys
    .filter((fk) => names.has(fk.fromTable) && names.has(fk.toTable))
    .map((fk) => `Ref: ${fk.fromTable}.${fk.fromColumn} > ${fk.toTable}.${fk.toColumn}`);
  return [...blocks, ...refs].join('\n\n') + '\n';
}

// Concatenate per-table DDL, each preceded by a `-- <table>` comment and
// normalized to exactly one trailing semicolon. Parts that failed to load are
// rendered as comments so one failure never aborts the export.
export function joinDdl(parts: DdlPart[]): string {
  return (
    parts
      .map((p) => {
        if ('error' in p) return `-- failed to load DDL for ${p.table}: ${p.error}`;
        const body = p.ddl.trim().replace(/;?\s*$/, ';');
        return `-- ${p.table}\n${body}`;
      })
      .join('\n\n') + '\n'
  );
}
