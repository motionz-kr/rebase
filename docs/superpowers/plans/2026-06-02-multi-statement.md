# Multi-statement / Multiple Result Sets Implementation Plan

**Goal:** Run a SQL script of several `;`-separated statements in one editor tab and show each statement's result set, DataGrip-style.

**Architecture:** Renderer-side. A pure `splitStatements()` splits the editor text into individual statements (quote/comment/dollar-quote aware). The editor runs them **sequentially** through the existing `executeQueryStream` IPC (one fresh queryId each), collecting one ResultSet per statement, stopping on the first error. Single-statement input keeps the existing code path 100% unchanged (zero regression risk). No engine change — each statement is classified/policy-gated individually, which is *stricter* than passing a multi-statement blob.

**Tech Stack:** TypeScript (pure split = TDD with vitest), React, existing Electron IPC.

> Branch `feat/multi-statement`. node/pnpm via nvm.

---

## Task MS-1: `splitStatements.ts` pure splitter (TDD)

**Files:**
- Create: `apps/renderer/src/lib/splitStatements.ts`
- Test: `apps/renderer/src/lib/splitStatements.test.ts`

Split a SQL string into trimmed, non-empty statements on top-level `;`, ignoring `;` inside:
single-quoted strings (`''` and `\'` escapes), double-quoted identifiers, backtick identifiers,
line comments (`-- …`, `# …`), block comments (`/* … */`), and PostgreSQL dollar-quoted bodies
(`$$ … $$`, `$tag$ … $tag$`).

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from 'vitest';
import { splitStatements } from './splitStatements';

describe('splitStatements', () => {
  it('returns single statement unchanged (no semicolon)', () => {
    expect(splitStatements('SELECT 1')).toEqual(['SELECT 1']);
  });
  it('splits two statements', () => {
    expect(splitStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });
  it('ignores trailing semicolon and whitespace', () => {
    expect(splitStatements('SELECT 1;  ')).toEqual(['SELECT 1']);
  });
  it('drops empty statements between semicolons', () => {
    expect(splitStatements('SELECT 1;;SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });
  it('ignores semicolons inside single-quoted strings', () => {
    expect(splitStatements("SELECT ';' AS x; SELECT 2")).toEqual(["SELECT ';' AS x", 'SELECT 2']);
  });
  it('handles doubled-quote escape inside string', () => {
    expect(splitStatements("SELECT 'a''b;c'; SELECT 2")).toEqual(["SELECT 'a''b;c'", 'SELECT 2']);
  });
  it('handles backslash escape inside string', () => {
    expect(splitStatements("SELECT 'a\\';b'; SELECT 2")).toEqual(["SELECT 'a\\';b'", 'SELECT 2']);
  });
  it('ignores semicolons inside double-quoted identifiers', () => {
    expect(splitStatements('SELECT "a;b" FROM t; SELECT 2')).toEqual(['SELECT "a;b" FROM t', 'SELECT 2']);
  });
  it('ignores semicolons inside backtick identifiers', () => {
    expect(splitStatements('SELECT `a;b` FROM t; SELECT 2')).toEqual(['SELECT `a;b` FROM t', 'SELECT 2']);
  });
  it('ignores semicolons inside line comments', () => {
    expect(splitStatements('SELECT 1 -- a;b\n; SELECT 2')).toEqual(['SELECT 1 -- a;b', 'SELECT 2']);
  });
  it('ignores semicolons inside hash line comments', () => {
    expect(splitStatements('SELECT 1 # a;b\n; SELECT 2')).toEqual(['SELECT 1 # a;b', 'SELECT 2']);
  });
  it('ignores semicolons inside block comments', () => {
    expect(splitStatements('SELECT 1 /* a;b */; SELECT 2')).toEqual(['SELECT 1 /* a;b */', 'SELECT 2']);
  });
  it('ignores semicolons inside dollar-quoted bodies', () => {
    expect(splitStatements('SELECT $$a;b$$; SELECT 2')).toEqual(['SELECT $$a;b$$', 'SELECT 2']);
  });
  it('ignores semicolons inside tagged dollar-quoted bodies', () => {
    expect(splitStatements('SELECT $tag$a;b$tag$; SELECT 2')).toEqual(['SELECT $tag$a;b$tag$', 'SELECT 2']);
  });
  it('returns empty array for blank / comment-only input', () => {
    expect(splitStatements('   ;  ')).toEqual([]);
    expect(splitStatements('')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify red** — `npx vitest run src/lib/splitStatements.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement minimal splitter**

```typescript
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
      while (i < n && sql[i] !== '\n') { buf += sql[i]; i++; }
      continue;
    }
    // block comment: /* ... */
    if (ch === '/' && next === '*') {
      buf += ch; buf += next; i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) { buf += sql[i]; i++; }
      if (i < n) { buf += '*'; buf += '/'; i += 2; }
      continue;
    }
    // dollar-quote: $tag$ ... $tag$
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        buf += tag; i += tag.length;
        const end = sql.indexOf(tag, i);
        if (end === -1) { buf += sql.slice(i); i = n; }
        else { buf += sql.slice(i, end + tag.length); i = end + tag.length; }
        continue;
      }
    }
    // quoted: ' " `
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      buf += ch; i++;
      while (i < n) {
        const c = sql[i];
        if (c === '\\' && q === "'") { buf += c; buf += sql[i + 1] ?? ''; i += 2; continue; }
        if (c === q && sql[i + 1] === q) { buf += c; buf += q; i += 2; continue; } // doubled escape
        buf += c; i++;
        if (c === q) break;
      }
      continue;
    }
    // statement terminator
    if (ch === ';') { push(); i++; continue; }

    buf += ch; i++;
  }
  push();
  return out;
}
```

- [ ] **Step 4: Run, verify green** — `npx vitest run src/lib/splitStatements.test.ts` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/renderer/src/lib/splitStatements.ts apps/renderer/src/lib/splitStatements.test.ts
git commit -m "feat(query): splitStatements pure SQL statement splitter (TDD)"
```

## Task MS-2: QueryTab result-set state + sequential runner

**Files:** Modify `apps/renderer/src/components/QueryEditor.tsx`

1. Extend `QueryTab` with `resultSets: ResultSet[]` and `activeResultIndex: number`; add a `ResultSet` type
   `{ statement: string; columns: string[]; rows: any[][]; rowsAffected: number | null; error: string | null; truncated: boolean; rowLimit: number }`.
   Initialize `resultSets: []`, `activeResultIndex: 0` in `newTab`.
2. In `executeQuery`, after computing `sql`, `const statements = splitStatements(sql);`. If `statements.length <= 1`, run the **existing** single-statement path unchanged (also clear `resultSets: []`). If `> 1`, call `runMultiStatements(statements, { allowWrite, confirmDestructive, fetchAll })` and return.
3. `runMultiStatements`: set tab `loading:true, error:null, resultSets:[], columns:[], rows:[], rowsAffected:null, policyPrompt:null`. Loop statements sequentially with `await runSingleStatementCollected(stmt, opts)`; push each returned ResultSet into the tab's `resultSets` (via setTabs). Stop the loop on a ResultSet whose `error` is non-null OR on a policy block. After the loop set `loading:false, activeResultIndex:0`.
4. `runSingleStatementCollected(stmt, opts)`: returns `Promise<ResultSet | { policy: PolicyPrompt }>`. Generate a fresh queryId, store it in a `multiCancelRef` (useRef) for cancellation, subscribe a **local** `onQueryStreamChunk` collector (separate from the global one; the global handler ignores it because the tab's `queryId` is never set to these ids), accumulate meta/row, resolve on `done`/`error`/`policy`, then call `window.electronAPI.executeQueryStream(queryId, profileId, stmt, opts)`; if the start call returns `{success:false}` resolve an error ResultSet.

Verify: `npx tsc --noEmit`.

## Task MS-3: Result-set strip UI + per-result rendering

**Files:** Modify `apps/renderer/src/components/QueryEditor.tsx`, `apps/renderer/src/styles.css` (or the file holding `.results`)

- In the Results block, when `activeTab.resultSets.length > 0`, render a **result-set tab strip** (`.result-strip`) with one chip per result: label `Result {n}` plus ` · {rows} rows` when it returned rows, ` · {rowsAffected} affected` when it was a write, or an error dot when it failed. Clicking sets `activeResultIndex`. Below it render the **selected** ResultSet using the same markup the single path uses (error alert / "rows affected" alert / truncated bar / `<ResultGrid>`), driven by `activeTab.resultSets[activeTab.activeResultIndex]` instead of the flat `columns/rows`.
- When `resultSets.length === 0`, render the existing single-statement markup unchanged.
- The cancel button calls `cancelQuery(multiCancelRef.current)` when in multi mode.

Verify: `npx tsc --noEmit && npx vitest run && npm run build`. Commit MS-2+MS-3:

```bash
git add -A && git commit -m "feat(query): run multi-statement scripts with per-statement result sets"
```

## Task MS-4: Live verification (CDP)

- Renderer HMRs (renderer-only change; no engine/desktop rebuild).
- Open the mysql (3306) connection. In the editor type:
  `SELECT id, name FROM demo_users; SELECT COUNT(*) AS n FROM demo_users; SELECT 'x' AS a;`
  Run. Confirm: 3 result-strip chips; chip 1 shows the user rows, chip 2 shows the count, chip 3 shows `x`; switching chips swaps the grid; editor text unmodified; single-statement queries still render exactly one grid (no strip).
- Confirm a script that fails mid-way (`SELECT 1; SELECT * FROM no_such_table; SELECT 3`) shows result 1 OK, result 2 error chip, and stops (no result 3).
- `demo_users` is the USER's data — only SELECTs here, nothing to restore.

## Task MS-5: Merge

```bash
git checkout main && git merge --no-ff feat/multi-statement -m "Merge feat/multi-statement: multi-statement scripts + result sets"
```
