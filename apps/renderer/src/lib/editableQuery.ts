import type { OrderBy } from './tableQuery';

export interface EditableQuery {
  table: string;
  orderBy: OrderBy | null;
  limit: number | null;
}

// Strip surrounding backticks/double-quotes and take the last dotted segment
// (so `schema`.`table` / "schema"."table" / schema.table → table).
function bareTable(token: string): string {
  const last = token.split('.').pop() ?? token;
  return last.replace(/^[`"]|[`"]$/g, '');
}

// Detect a query whose result maps cleanly to a single base table, so the result
// grid can offer inline editing. Only a plain `SELECT * FROM <table>` with an
// optional single-column ORDER BY and LIMIT qualifies — anything with a WHERE,
// JOIN, GROUP BY, computed columns, etc. stays read-only.
export function analyzeEditableQuery(sql: string): EditableQuery | null {
  const s = sql.trim().replace(/;+\s*$/, '').replace(/\s+/g, ' ').trim();
  const head = /^select \* from (.+)$/i.exec(s);
  if (!head) return null;

  const rest = head[1];
  const sp = rest.indexOf(' ');
  const tableToken = sp === -1 ? rest : rest.slice(0, sp);
  const clauses = (sp === -1 ? '' : rest.slice(sp + 1)).trim();

  // Table token must be a (optionally schema-qualified, optionally quoted) name.
  if (!/^(?:`[^`]+`|"[^"]+"|\w+)(?:\.(?:`[^`]+`|"[^"]+"|\w+))?$/.test(tableToken)) return null;

  if (clauses === '') return { table: bareTable(tableToken), orderBy: null, limit: null };

  // Only ORDER BY <col> [ASC|DESC] and/or LIMIT <n> [OFFSET <n>] may follow.
  const m = /^(?:order by (`[^`]+`|"[^"]+"|\w+(?:\.\w+)?) ?(asc|desc)?)? ?(?:limit (\d+)(?: offset \d+)?)?$/i.exec(clauses);
  if (!m) return null;

  let orderBy: OrderBy | null = null;
  if (m[1]) orderBy = { col: bareTable(m[1]), dir: (m[2] || 'asc').toLowerCase() as 'asc' | 'desc' };
  const limit = m[3] ? parseInt(m[3], 10) : null;
  return { table: bareTable(tableToken), orderBy, limit };
}
