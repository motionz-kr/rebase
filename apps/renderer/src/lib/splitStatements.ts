// Split SQL into individual statements on top-level ';'. Quote/comment/dollar-quote
// aware so semicolons inside literals, identifiers, comments, and PG dollar bodies
// do not split. Returns trimmed, non-empty statements.
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  const n = sql.length;

  const push = () => {
    const t = buf.trim();
    if (t) out.push(t);
    buf = '';
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
      push();
      i++;
      continue;
    }

    buf += ch;
    i++;
  }
  push();
  return out;
}
