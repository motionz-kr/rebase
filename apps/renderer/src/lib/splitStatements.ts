export interface SqlStatementRange {
  statement: string;
  /** UTF-16 source offset, inclusive. */
  start: number;
  /** UTF-16 source offset, exclusive. */
  end: number;
}

// Split SQL into individual statements on top-level ';'. Quote/comment/dollar-quote
// aware so semicolons inside literals, identifiers, comments, and PG dollar bodies
// do not split. Returns trimmed, non-empty statements with source offsets.
export function splitStatementRanges(sql: string): SqlStatementRange[] {
  const out: SqlStatementRange[] = [];
  let buf = '';
  let statementStart = 0;
  let i = 0;
  const n = sql.length;

  const push = (statementEnd: number) => {
    const t = buf.trim();
    if (t) {
      const leading = buf.length - buf.trimStart().length;
      const trailing = buf.length - buf.trimEnd().length;
      out.push({
        statement: t,
        start: statementStart + leading,
        end: statementStart + buf.length - trailing,
      });
    }
    buf = '';
    statementStart = statementEnd + 1;
  };

  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // line comment: -- ... or # ...
    if ((ch === '-' && next === '-') || ch === '#') {
      while (i < n && sql[i] !== '\n') {
        buf += sql[i];
        i++;
      }
      continue;
    }
    // block comment: /* ... */
    if (ch === '/' && next === '*') {
      buf += ch;
      buf += next;
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
        buf += sql[i];
        i++;
      }
      if (i < n) {
        buf += '*';
        buf += '/';
        i += 2;
      }
      continue;
    }
    // dollar-quote: $tag$ ... $tag$
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        buf += tag;
        i += tag.length;
        const end = sql.indexOf(tag, i);
        if (end === -1) {
          buf += sql.slice(i);
          i = n;
        } else {
          buf += sql.slice(i, end + tag.length);
          i = end + tag.length;
        }
        continue;
      }
    }
    // quoted: ' " `
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      buf += ch;
      i++;
      while (i < n) {
        const c = sql[i];
        if (c === '\\' && q === "'") {
          buf += c;
          buf += sql[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (c === q && sql[i + 1] === q) {
          buf += c;
          buf += q;
          i += 2;
          continue; // doubled escape
        }
        buf += c;
        i++;
        if (c === q) break;
      }
      continue;
    }
    // statement terminator
    if (ch === ';') {
      push(i);
      i++;
      continue;
    }

    buf += ch;
    i++;
  }
  push(n - 1);
  return out;
}

export function splitStatements(sql: string): string[] {
  return splitStatementRanges(sql).map((range) => range.statement);
}
