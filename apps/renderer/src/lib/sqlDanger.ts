// Mirror of the engine's dangerous-statement classifier (engine/internal/agent/
// danger.go), used to badge agent write proposals and gate auto-run.

export type Risk = 'safe' | 'dangerous';

export interface Classification {
  risk: Risk;
  reasons: string[];
}

function normalize(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ') // line comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/'(?:[^']|'')*'/g, "''") // string literals
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyStatement(sql: string): Classification {
  const n = normalize(sql);
  const u = n.toUpperCase();
  const reasons: string[] = [];
  const hasWhere = /\bWHERE\b/i.test(n);

  if (u.startsWith('DROP ')) reasons.push('DROP removes a database object');
  else if (u.startsWith('TRUNCATE')) reasons.push('TRUNCATE empties a table');
  else if (u.startsWith('DELETE') && !hasWhere) reasons.push('DELETE without a WHERE clause affects every row');
  else if (u.startsWith('UPDATE') && !hasWhere) reasons.push('UPDATE without a WHERE clause affects every row');

  if (u.startsWith('ALTER') && u.includes(' DROP ')) reasons.push('ALTER … DROP removes a column/constraint');

  return reasons.length > 0 ? { risk: 'dangerous', reasons } : { risk: 'safe', reasons: [] };
}
