# ER / Schema Diagram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only ER diagram — every table as a node with its columns, FK edges between them, auto-laid-out and searchable — opened from the schema explorer's database menu.

**Architecture:** A new one-shot engine endpoint `GET /schema-graph` returns tables (with columns + PK) and FK edges in a single round-trip. Pure renderer helpers build/layout/filter the graph; an `ErDiagram` React Flow component renders it. dagre does deterministic layout.

**Tech Stack:** Go engine (mysql/postgres `information_schema`), React 19 + React Flow (`@xyflow/react`) + dagre (`@dagrejs/dagre`), vitest, CDP live.

**Spec:** `docs/superpowers/specs/2026-06-04-er-diagram-design.md`

**Go binary:** `/Users/smlee/sdk/go/bin/go`. Engine rebuild for the app: `go build -o apps/desktop/bin/app-engine ./engine/cmd/app-engine` then restart Electron.

---

## Phase P1 — Engine schema-graph endpoint

### Task 1: Schema-graph types + MySQL `GetSchemaGraph` (TDD integration)

**Files:**
- Modify: `engine/internal/ports/connector.go`
- Modify: `engine/internal/adapters/mysql/mysql_adapter.go`
- Test: `engine/internal/adapters/mysql/mysql_schema_graph_test.go`

- [ ] **Step 1: Add result types to ports**

In `connector.go`, after the `ForeignKey` type:

```go
// SchemaGraphTable + SchemaGraphFK + SchemaGraph describe a whole database's
// table/column structure and FK relationships for the ER diagram, in one shot.
type SchemaGraphTable struct {
	Name    string       `json:"name"`
	Columns []ColumnInfo `json:"columns"`
}

type SchemaGraphFK struct {
	FromTable  string `json:"fromTable"`
	FromColumn string `json:"fromColumn"`
	ToTable    string `json:"toTable"`
	ToColumn   string `json:"toColumn"`
}

type SchemaGraph struct {
	Tables      []SchemaGraphTable `json:"tables"`
	ForeignKeys []SchemaGraphFK    `json:"foreignKeys"`
}
```

- [ ] **Step 2: Write the failing MySQL integration test**

Create `engine/internal/adapters/mysql/mysql_schema_graph_test.go`. Mirror the existing mysql integration tests' connection/setup (reuse the same `testProfile()`/skip-if-no-DB helper this package already uses — check `mysql_adapter_test.go` for the exact helper name and copy its guard). Create two throwaway tables with an FK, then assert the graph:

```go
func TestMySQLGetSchemaGraph(t *testing.T) {
	c, p, pw, db := mysqlTestConn(t) // existing helper pattern in this package
	ctx := context.Background()
	exec := func(sql string) { _, _, err := c.ExecuteBatch(ctx, p, pw, []string{sql}); if err != nil { t.Fatalf("setup: %v", err) } }
	exec("DROP TABLE IF EXISTS erg_orders")
	exec("DROP TABLE IF EXISTS erg_users")
	exec("CREATE TABLE erg_users (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL)")
	exec("CREATE TABLE erg_orders (id INT PRIMARY KEY, user_id INT, FOREIGN KEY (user_id) REFERENCES erg_users(id))")
	defer func() { exec("DROP TABLE IF EXISTS erg_orders"); exec("DROP TABLE IF EXISTS erg_users") }()

	g, err := c.GetSchemaGraph(ctx, p, pw, db)
	if err != nil { t.Fatalf("GetSchemaGraph: %v", err) }

	users := findTable(g.Tables, "erg_users")
	if users == nil { t.Fatal("erg_users missing") }
	idCol := findCol(users.Columns, "id")
	if idCol == nil || !idCol.PrimaryKey { t.Errorf("erg_users.id should be PK: %+v", users.Columns) }

	var fk *ports.SchemaGraphFK
	for i := range g.ForeignKeys {
		if g.ForeignKeys[i].FromTable == "erg_orders" && g.ForeignKeys[i].FromColumn == "user_id" { fk = &g.ForeignKeys[i] }
	}
	if fk == nil || fk.ToTable != "erg_users" || fk.ToColumn != "id" {
		t.Errorf("expected erg_orders.user_id -> erg_users.id, got %+v", g.ForeignKeys)
	}
}

func findTable(ts []ports.SchemaGraphTable, n string) *ports.SchemaGraphTable { for i := range ts { if ts[i].Name == n { return &ts[i] } }; return nil }
func findCol(cs []ports.ColumnInfo, n string) *ports.ColumnInfo { for i := range cs { if cs[i].Name == n { return &cs[i] } }; return nil }
```

(If this package's connection helper has a different name/signature, adapt the first line; the rest is unchanged.)

- [ ] **Step 3: Run it — verify it fails**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/mysql/ -run TestMySQLGetSchemaGraph`
Expected: FAIL — `c.GetSchemaGraph undefined`.

- [ ] **Step 4: Implement `GetSchemaGraph` on the MySQL connector**

Add to `mysql_adapter.go`:

```go
func (c *MySQLConnector) GetSchemaGraph(ctx context.Context, p domain.ConnectionProfile, password string, database string) (ports.SchemaGraph, error) {
	db, err := c.connect(p, password, database)
	if err != nil {
		return ports.SchemaGraph{}, err
	}
	defer db.Close()

	colRows, err := db.QueryContext(ctx, `
		SELECT table_name, column_name, data_type, is_nullable, column_key
		FROM information_schema.columns
		WHERE table_schema = ?
		ORDER BY table_name, ordinal_position
	`, database)
	if err != nil {
		return ports.SchemaGraph{}, c.normalizeError(err)
	}
	defer colRows.Close()

	order := []string{}
	byTable := map[string]*ports.SchemaGraphTable{}
	for colRows.Next() {
		var tbl, col, typ, nullable, key string
		if err := colRows.Scan(&tbl, &col, &typ, &nullable, &key); err != nil {
			return ports.SchemaGraph{}, c.normalizeError(err)
		}
		t, ok := byTable[tbl]
		if !ok {
			t = &ports.SchemaGraphTable{Name: tbl}
			byTable[tbl] = t
			order = append(order, tbl)
		}
		t.Columns = append(t.Columns, ports.ColumnInfo{Name: col, Type: typ, Nullable: nullable == "YES", PrimaryKey: key == "PRI"})
	}

	fkRows, err := db.QueryContext(ctx, `
		SELECT table_name, column_name, referenced_table_name, referenced_column_name
		FROM information_schema.key_column_usage
		WHERE table_schema = ? AND referenced_table_name IS NOT NULL
	`, database)
	if err != nil {
		return ports.SchemaGraph{}, c.normalizeError(err)
	}
	defer fkRows.Close()

	var fks []ports.SchemaGraphFK
	for fkRows.Next() {
		var fk ports.SchemaGraphFK
		if err := fkRows.Scan(&fk.FromTable, &fk.FromColumn, &fk.ToTable, &fk.ToColumn); err != nil {
			return ports.SchemaGraph{}, c.normalizeError(err)
		}
		fks = append(fks, fk)
	}

	g := ports.SchemaGraph{ForeignKeys: fks}
	for _, name := range order {
		g.Tables = append(g.Tables, *byTable[name])
	}
	return g, nil
}
```

- [ ] **Step 5: Run it — verify it passes**

Run: `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/mysql/ -run TestMySQLGetSchemaGraph`
Expected: PASS (needs the local dev-mysql; this package's other integration tests already require it).

- [ ] **Step 6: Commit**

```bash
git add engine/internal/ports/connector.go engine/internal/adapters/mysql/mysql_adapter.go engine/internal/adapters/mysql/mysql_schema_graph_test.go
git commit -m "feat(engine): MySQL GetSchemaGraph (tables+columns+FKs in one shot, TDD)"
```

### Task 2: PostgreSQL `GetSchemaGraph` (TDD integration)

**Files:**
- Modify: `engine/internal/adapters/postgres/postgres_adapter.go`
- Test: `engine/internal/adapters/postgres/postgres_schema_graph_test.go`

- [ ] **Step 1: Write the failing test** — mirror Task 1's test using this package's postgres test-connection helper (check `postgres_adapter_test.go` for the helper + skip guard). Same tables/asserts (`erg_users`, `erg_orders`, FK `user_id → erg_users.id`).

- [ ] **Step 2: Run it — verify it fails** — `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/postgres/ -run TestPostgresGetSchemaGraph` → FAIL (undefined).

- [ ] **Step 3: Implement `GetSchemaGraph` on the PostgreSQL connector**

Add to `postgres_adapter.go`. Use the package's existing schema convention (the other postgres introspection methods qualify by `table_schema` — match whatever they pass, typically `'public'`; reuse the same `c.connect(...)` + `c.normalizeError(...)` helpers):

```go
func (c *PostgreSQLConnector) GetSchemaGraph(ctx context.Context, p domain.ConnectionProfile, password string, database string) (ports.SchemaGraph, error) {
	db, err := c.connect(p, password, database)
	if err != nil {
		return ports.SchemaGraph{}, err
	}
	defer db.Close()

	colRows, err := db.QueryContext(ctx, `
		SELECT c.table_name, c.column_name, c.data_type, c.is_nullable,
		       (pk.column_name IS NOT NULL) AS is_pk
		FROM information_schema.columns c
		LEFT JOIN (
			SELECT kcu.table_name, kcu.column_name
			FROM information_schema.table_constraints tc
			JOIN information_schema.key_column_usage kcu
			  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
			WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
		) pk ON pk.table_name = c.table_name AND pk.column_name = c.column_name
		WHERE c.table_schema = 'public'
		ORDER BY c.table_name, c.ordinal_position
	`)
	if err != nil {
		return ports.SchemaGraph{}, c.normalizeError(err)
	}
	defer colRows.Close()

	order := []string{}
	byTable := map[string]*ports.SchemaGraphTable{}
	for colRows.Next() {
		var tbl, col, typ, nullable string
		var isPK bool
		if err := colRows.Scan(&tbl, &col, &typ, &nullable, &isPK); err != nil {
			return ports.SchemaGraph{}, c.normalizeError(err)
		}
		t, ok := byTable[tbl]
		if !ok {
			t = &ports.SchemaGraphTable{Name: tbl}
			byTable[tbl] = t
			order = append(order, tbl)
		}
		t.Columns = append(t.Columns, ports.ColumnInfo{Name: col, Type: typ, Nullable: nullable == "YES", PrimaryKey: isPK})
	}

	fkRows, err := db.QueryContext(ctx, `
		SELECT kcu.table_name, kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
		FROM information_schema.table_constraints tc
		JOIN information_schema.key_column_usage kcu
		  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
		JOIN information_schema.constraint_column_usage ccu
		  ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
		WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
	`)
	if err != nil {
		return ports.SchemaGraph{}, c.normalizeError(err)
	}
	defer fkRows.Close()

	var fks []ports.SchemaGraphFK
	for fkRows.Next() {
		var fk ports.SchemaGraphFK
		if err := fkRows.Scan(&fk.FromTable, &fk.FromColumn, &fk.ToTable, &fk.ToColumn); err != nil {
			return ports.SchemaGraph{}, c.normalizeError(err)
		}
		fks = append(fks, fk)
	}

	g := ports.SchemaGraph{ForeignKeys: fks}
	for _, name := range order {
		g.Tables = append(g.Tables, *byTable[name])
	}
	return g, nil
}
```

- [ ] **Step 4: Run it — verify it passes** — `/Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/postgres/ -run TestPostgresGetSchemaGraph` → PASS (needs local verify-pg).

- [ ] **Step 5: Commit**

```bash
git add engine/internal/adapters/postgres/postgres_adapter.go engine/internal/adapters/postgres/postgres_schema_graph_test.go
git commit -m "feat(engine): PostgreSQL GetSchemaGraph (TDD)"
```

### Task 3: Port method + HTTP handler + route + IPC + types

**Files:**
- Modify: `engine/internal/ports/connector.go` (add to interface)
- Modify: `engine/internal/transport/http/introspection.go`
- Modify: `engine/cmd/app-engine/main.go`
- Modify: `apps/desktop/src/main/index.ts`, `apps/desktop/src/preload/index.ts`, `apps/renderer/src/global.d.ts`

- [ ] **Step 1: Add to the SQLConnector interface**

In `connector.go`, inside `type SQLConnector interface { ... }`, after `ListForeignKeys`:

```go
	GetSchemaGraph(ctx context.Context, p domain.ConnectionProfile, password string, database string) (SchemaGraph, error)
```

- [ ] **Step 2: Add the handler**

In `introspection.go`, mirror the existing `SchemaCompletion()` handler (same token check, query-param parsing of `profileId`/`database`, getConnector, JSON encode):

```go
// SchemaGraph returns tables+columns+FKs for the whole database (ER diagram).
func (h *IntrospectionHandler) SchemaGraph() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !validToken(r.Header.Get("X-App-Engine-Token"), h.token) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		profileID := r.URL.Query().Get("profileId")
		database := r.URL.Query().Get("database")
		profile, password, err := h.service.GetProfile(r.Context(), profileID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		conn, err := h.connectorFor(profile.Driver) // use the existing connector lookup in this handler
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		graph, err := conn.GetSchemaGraph(r.Context(), *profile, password, database)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(graph)
	})
}
```

(Match the exact field/method names this handler already uses — copy `SchemaCompletion()` and change the body to call `GetSchemaGraph`.)

- [ ] **Step 3: Register the route** in `main.go` after `/schema-completion`:

```go
	mux.Handle("/schema-graph", introHandler.SchemaGraph())
```

- [ ] **Step 4: IPC + preload + types**

main `index.ts` — mirror an existing introspection IPC (e.g. `get-schema-completion`):

```ts
  getSchemaGraph: (profileId: string, database: string) =>
    engineGet(`/schema-graph?profileId=${encodeURIComponent(profileId)}&database=${encodeURIComponent(database)}`),
```

(Use whatever GET helper the other introspection IPCs use; if they each build an `http.request`, copy that shape and the `ipcMain.handle('get-schema-graph', ...)`.)

preload `index.ts`:

```ts
  getSchemaGraph: (profileId: string, database: string) => ipcRenderer.invoke('get-schema-graph', profileId, database),
```

`global.d.ts` — add the types + method:

```ts
export interface SchemaGraphColumn { name: string; type: string; nullable: boolean; primaryKey: boolean }
export interface SchemaGraphTable { name: string; columns: SchemaGraphColumn[] }
export interface SchemaGraphFK { fromTable: string; fromColumn: string; toTable: string; toColumn: string }
export interface SchemaGraph { tables: SchemaGraphTable[]; foreignKeys: SchemaGraphFK[] }
```
and in the `electronAPI` interface:
```ts
      getSchemaGraph: (profileId: string, database: string) => Promise<ResultWrapper<SchemaGraph>>;
```

- [ ] **Step 5: Build + test the engine + type-check desktop/renderer**

Run: `/Users/smlee/sdk/go/bin/go build ./engine/... && /Users/smlee/sdk/go/bin/go test ./engine/internal/adapters/... ./engine/internal/transport/...`
Then: `pnpm --filter desktop build && pnpm --filter renderer build`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add engine/internal/ports/connector.go engine/internal/transport/http/introspection.go engine/cmd/app-engine/main.go apps/desktop/src/main/index.ts apps/desktop/src/preload/index.ts apps/renderer/src/global.d.ts
git commit -m "feat(mcp? no): /schema-graph endpoint + IPC for the ER diagram"
```
(Use message: `feat(engine): /schema-graph endpoint + IPC for the ER diagram`.)

---

## Phase P2 — Pure graph helpers (TDD) + libs

### Task 4: Add React Flow + dagre

**Files:** `apps/renderer/package.json`

- [ ] **Step 1:** `pnpm --filter renderer add @xyflow/react @dagrejs/dagre`
- [ ] **Step 2: verify** `pnpm --filter renderer exec node -e "require('@dagrejs/dagre'); console.log('ok')"` → `ok`
- [ ] **Step 3: commit** `git add apps/renderer/package.json pnpm-lock.yaml && git commit -m "build(renderer): add @xyflow/react + @dagrejs/dagre for the ER diagram"`

### Task 5: `buildErGraph` + `filterErGraph` + `relatedIds` (TDD)

**Files:**
- Create: `apps/renderer/src/lib/erGraph.ts`
- Test: `apps/renderer/src/lib/erGraph.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildErGraph, filterErGraph, relatedIds } from './erGraph';
import type { SchemaGraph } from '../global';

const g: SchemaGraph = {
  tables: [
    { name: 'users', columns: [{ name: 'id', type: 'int', nullable: false, primaryKey: true }] },
    { name: 'orders', columns: [{ name: 'id', type: 'int', nullable: false, primaryKey: true }, { name: 'user_id', type: 'int', nullable: true, primaryKey: false }] },
    { name: 'logs', columns: [{ name: 'id', type: 'int', nullable: false, primaryKey: true }] },
  ],
  foreignKeys: [{ fromTable: 'orders', fromColumn: 'user_id', toTable: 'users', toColumn: 'id' }],
};

describe('buildErGraph', () => {
  it('makes a table node per table and an edge per FK', () => {
    const { nodes, edges } = buildErGraph(g);
    expect(nodes.map((n) => n.id).sort()).toEqual(['logs', 'orders', 'users']);
    expect(nodes[0].type).toBe('table');
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('orders');
    expect(edges[0].target).toBe('users');
  });
  it('skips an FK to a missing table', () => {
    const bad: SchemaGraph = { tables: g.tables, foreignKeys: [{ fromTable: 'orders', fromColumn: 'x', toTable: 'ghost', toColumn: 'id' }] };
    expect(buildErGraph(bad).edges).toHaveLength(0);
  });
});

describe('filterErGraph', () => {
  it('empty query returns the full graph', () => {
    expect(filterErGraph(g, '').tables).toHaveLength(3);
  });
  it('matches a table name and includes FK-neighbors', () => {
    const out = filterErGraph(g, 'orders');
    const names = out.tables.map((t) => t.name).sort();
    expect(names).toEqual(['orders', 'users']); // orders + its FK neighbor users; logs excluded
  });
});

describe('relatedIds', () => {
  it('returns the table plus FK-connected tables and edge ids', () => {
    const r = relatedIds(g, 'users');
    expect([...r.tables].sort()).toEqual(['orders', 'users']);
    expect(r.edges.size).toBe(1);
  });
});
```

- [ ] **Step 2: Run it — verify it fails** — `pnpm --filter renderer test -- erGraph` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
import type { SchemaGraph, SchemaGraphTable } from '../global';

export interface ErNode {
  id: string;
  type: 'table';
  position: { x: number; y: number };
  data: { name: string; columns: SchemaGraphTable['columns'] };
}
export interface ErEdge {
  id: string;
  source: string;
  target: string;
  data: { fromColumn: string; toColumn: string };
}
export interface ErGraph {
  nodes: ErNode[];
  edges: ErEdge[];
}

export function buildErGraph(g: SchemaGraph): ErGraph {
  const names = new Set(g.tables.map((t) => t.name));
  const nodes: ErNode[] = g.tables.map((t) => ({
    id: t.name,
    type: 'table',
    position: { x: 0, y: 0 },
    data: { name: t.name, columns: t.columns },
  }));
  const edges: ErEdge[] = g.foreignKeys
    .filter((fk) => names.has(fk.fromTable) && names.has(fk.toTable))
    .map((fk, i) => ({
      id: `e${i}-${fk.fromTable}.${fk.fromColumn}-${fk.toTable}.${fk.toColumn}`,
      source: fk.fromTable,
      target: fk.toTable,
      data: { fromColumn: fk.fromColumn, toColumn: fk.toColumn },
    }));
  return { nodes, edges };
}

// Tables matching the query (by table name or any column name) plus their direct
// FK-neighbors, and only FKs between kept tables.
export function filterErGraph(g: SchemaGraph, query: string): SchemaGraph {
  const q = query.trim().toLowerCase();
  if (!q) return g;
  const matched = new Set(
    g.tables
      .filter((t) => t.name.toLowerCase().includes(q) || t.columns.some((c) => c.name.toLowerCase().includes(q)))
      .map((t) => t.name)
  );
  const keep = new Set(matched);
  for (const fk of g.foreignKeys) {
    if (matched.has(fk.fromTable)) keep.add(fk.toTable);
    if (matched.has(fk.toTable)) keep.add(fk.fromTable);
  }
  return {
    tables: g.tables.filter((t) => keep.has(t.name)),
    foreignKeys: g.foreignKeys.filter((fk) => keep.has(fk.fromTable) && keep.has(fk.toTable)),
  };
}

// The table id + FK-connected table ids, and the connecting edge ids.
export function relatedIds(g: SchemaGraph, tableId: string): { tables: Set<string>; edges: Set<string> } {
  const tables = new Set<string>([tableId]);
  const edges = new Set<string>();
  buildErGraph(g).edges.forEach((e) => {
    if (e.source === tableId || e.target === tableId) {
      tables.add(e.source);
      tables.add(e.target);
      edges.add(e.id);
    }
  });
  return { tables, edges };
}
```

- [ ] **Step 4: Run it — verify it passes** — `pnpm --filter renderer test -- erGraph` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/renderer/src/lib/erGraph.ts apps/renderer/src/lib/erGraph.test.ts
git commit -m "feat(er): pure ER graph build/filter/related helpers (TDD)"
```

### Task 6: `layoutErGraph` with dagre (TDD)

**Files:**
- Modify: `apps/renderer/src/lib/erGraph.ts`
- Modify: `apps/renderer/src/lib/erGraph.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { layoutErGraph } from './erGraph';
// ... (g from above)
describe('layoutErGraph', () => {
  it('assigns a unique position to every node', () => {
    const laid = layoutErGraph(buildErGraph(g));
    expect(laid.nodes).toHaveLength(3);
    for (const n of laid.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
    const keys = new Set(laid.nodes.map((n) => `${n.position.x},${n.position.y}`));
    expect(keys.size).toBe(3); // no two nodes overlap
  });
});
```

- [ ] **Step 2: Run it — verify it fails** — `pnpm --filter renderer test -- erGraph` → FAIL (`layoutErGraph` undefined).

- [ ] **Step 3: Implement**

```ts
import dagre from '@dagrejs/dagre';

const NODE_W = 220;
const ROW_H = 22;
const HEADER_H = 34;

export function layoutErGraph(graph: ErGraph): ErGraph {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) {
    g.setNode(n.id, { width: NODE_W, height: HEADER_H + n.data.columns.length * ROW_H });
  }
  for (const e of graph.edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  const nodes = graph.nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, position: { x: p.x - NODE_W / 2, y: p.y - (HEADER_H + n.data.columns.length * ROW_H) / 2 } };
  });
  return { nodes, edges: graph.edges };
}
```

- [ ] **Step 4: Run it — verify it passes** — `pnpm --filter renderer test -- erGraph` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/renderer/src/lib/erGraph.ts apps/renderer/src/lib/erGraph.test.ts
git commit -m "feat(er): deterministic dagre layout for the ER graph (TDD)"
```

---

## Phase P3 — Component + wiring

### Task 7: `TableNode` + `ErDiagram` components

**Files:**
- Create: `apps/renderer/src/components/ErDiagram.tsx` (includes the `TableNode`)
- Modify: `apps/renderer/src/App.css`

- [ ] **Step 1: Build the component**

`ErDiagram.tsx`:
- Props `{ profileId: string; database: string; onOpenTable?: (table: string) => void }`.
- On mount + when `database` changes: `getSchemaGraph(profileId, database)` → store the raw `SchemaGraph`; on error set an error state.
- A `search` state; `view = useMemo(() => layoutErGraph(buildErGraph(filterErGraph(raw, search))), [raw, search])`.
- Large-schema guard: if `raw.tables.length > 60 && !search` → render a centered notice ("60개 이상 테이블 — 검색으로 좁히세요") + the search box, skip the canvas.
- React Flow: `<ReactFlow nodes={view.nodes} edges={styledEdges} nodeTypes={{ table: TableNode }} fitView>` with `<Background/> <Controls/> <MiniMap/>`. Import `@xyflow/react` + its CSS (`import '@xyflow/react/dist/style.css'`).
- `selected` state (table id | null): on node click set it; compute `relatedIds(raw, selected)` to add a `dim`/`hl` class to nodes/edges (pass via node `data.dimmed` + edge `className`). Click pane → clear.
- Node double-click → `onOpenTable?.(id)`.
- Toolbar: search `<input>`, table count, "맞춤 보기" button (calls React Flow `fitView` via an instance ref / `useReactFlow`).

`TableNode` (registered in `nodeTypes`): a `.er-node` div — header with the table name; a row per column (`.er-col`) showing `🔑` when `primaryKey`, the column name, and a muted type; add `er-node-dim` class when `data.dimmed`.

- [ ] **Step 2: Add CSS** to `App.css` (`.er-node`, `.er-node-head`, `.er-col`, `.er-col .pk`, `.er-node-dim { opacity: .25 }`, `.er-toolbar`, `.er-wrap { height: 100% }`). Use the existing theme tokens.

- [ ] **Step 3: Type-check** — `pnpm --filter renderer build` → succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/renderer/src/components/ErDiagram.tsx apps/renderer/src/App.css
git commit -m "feat(er): ErDiagram + TableNode (React Flow) with search + highlight"
```

### Task 8: Open from the schema explorer DB menu (new tab)

**Files:**
- Modify: `apps/renderer/src/components/SchemaExplorer.tsx`
- Modify: `apps/renderer/src/App.tsx` (tab host)

- [ ] **Step 1: Add the menu item** — in `SchemaExplorer`, the database-node context menu (where "create table" etc. live) gains **"ER 다이어그램"**, calling a new prop `onOpenErDiagram(database)`.

- [ ] **Step 2: Host the tab** — in `App.tsx`, follow the existing content-tab pattern (how a table-data view or query tab is opened/tracked). Add an `er` tab kind carrying `{ database }`; render `<ErDiagram profileId={...} database={...} onOpenTable={(t) => openTableDataTab(t)} />`. Wire `onOpenErDiagram` from `SchemaExplorer` to open that tab.

- [ ] **Step 3: Build + lint** — `pnpm --filter renderer build && pnpm --filter renderer lint` → green.

- [ ] **Step 4: Commit**

```bash
git add apps/renderer/src/components/SchemaExplorer.tsx apps/renderer/src/App.tsx
git commit -m "feat(er): open the ER diagram from the schema explorer DB menu"
```

---

## Phase P4 — Live verification + docs

### Task 9: Live-verify via CDP

- [ ] **Step 1:** Rebuild engine → `apps/desktop/bin/app-engine`; `pnpm --filter desktop build`; restart Electron (CDP 9222).
- [ ] **Step 2:** Connect dev-mysql. Via CDP: call `window.electronAPI.getSchemaGraph('<dev-mysql-id>','devdb')` and assert it returns `tables` incl. `demo_users` with columns.
- [ ] **Step 3:** Open the ER diagram (drive the DB context menu → "ER 다이어그램", or set the tab state). Assert the DOM has `.er-node` for `demo_users` and the React Flow canvas rendered.
- [ ] **Step 4:** Create a throwaway FK'd pair in dev-mysql (via the query path), reopen, and assert an edge (`.react-flow__edge`) appears; type in the search box and assert the node count narrows; click a node and assert non-related nodes get `er-node-dim`. Drop the throwaway tables afterward.
- [ ] **Step 5:** If anything fails, fix the component/helper and re-run.

### Task 10: Docs + full regression + PR

- [ ] **Step 1:** Add a short `docs/er-diagram.md` (what it is, how to open it, search/highlight, read-only, supported drivers) and a README docs-table row.
- [ ] **Step 2:** `pnpm --filter renderer test && pnpm --filter renderer lint && pnpm --filter renderer build`; `pnpm --filter desktop build`; `/Users/smlee/sdk/go/bin/go test ./engine/...`. All green.
- [ ] **Step 3:** `git add` docs + `git commit -m "docs: ER diagram guide"`; `git push -u origin feat/er-diagram`; open PR `feat(er): read-only schema/ER diagram` into main. Closes #35.

---

## Notes for the implementer

- **Conventional Commits** (release-please); co-author trailer on every commit. PR title must be a valid Conventional Commit.
- **Live DBs:** the mysql/postgres `GetSchemaGraph` tests need the local dev DBs (same as the existing integration tests in those packages). Never mutate non-throwaway tables.
- **React Flow CSS** must be imported or the canvas renders unstyled.
- Branch protection: merge via PR; CI (`checks`) must pass.
