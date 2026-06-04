# ER / Schema Diagram — Design

**Status:** approved (brainstorming) · **Milestone:** #6 (Productivity & visualization) · **Epic:** #35

## Goal

Give users a **read-only** visual map of a database: every table as a node
listing its columns, with edges for foreign-key relationships — auto-laid-out,
pannable/zoomable, searchable, and openable from the schema explorer.

## Context (current state)

- The engine already introspects schema piecewise: `ListTables`,
  `DescribeTable` (columns), `ListForeignKeys` (per table) over `SQLConnector`
  (mysql/postgres). `GET /schema-completion` returns tables + columns (no FKs).
- The renderer has a `SchemaExplorer` (tables/views/indexes/FKs) and opens
  content in tabs (query editor, table data view). No diagram/visualization or
  graph library exists.
- This is **sub-project 1** of milestone #6. The other epic items (saved-query
  search/snippets, history search, SQL export) are separate, smaller follow-ups;
  the virtualized grid already exists.

## Decisions

1. **Read-only** visualization (no schema editing from the diagram).
2. **React Flow** (`@xyflow/react`) for the canvas (nodes/edges/pan/zoom) +
   **dagre** (`@dagrejs/dagre`) for deterministic auto-layout.
3. **Show the whole schema** with a **search/filter** to focus; a guard for very
   large schemas (require a filter past a threshold).
4. Opened as a **new content tab** from the schema explorer's **database node**
   context menu ("ER 다이어그램").
5. Supported drivers: **mysql, postgres** (the SQL drivers; Redis has no schema
   graph).

## Architecture

Three isolated units plus the engine endpoint.

### Engine — one-shot schema graph

- New `GET /schema-graph?profileId=<id>&database=<db>` returning, in a single
  round-trip:
  ```json
  {
    "tables": [{ "name": "users",
      "columns": [{ "name": "id", "type": "int", "pk": true, "nullable": false }] }],
    "foreignKeys": [{ "fromTable": "orders", "fromColumn": "user_id",
                     "toTable": "users", "toColumn": "id" }]
  }
  ```
- Built from `information_schema` with **one query per concern per driver**
  (columns+PK in one query, FKs in one query) — not N per-table calls. Lives in
  the existing mysql/postgres adapters behind a `SchemaGraph(ctx, profile, db)`
  method on a small port, wired through a `SchemaHandler`.

### Renderer pure logic (TDD) — `apps/renderer/src/lib/erGraph.ts`

- `buildErGraph(tables, foreignKeys)` → `{ nodes, edges }` where each node is a
  React-Flow node (`type: 'table'`, `data: { name, columns }`) and each edge is
  an FK (`source`/`target` table ids, `data: { fromColumn, toColumn }`). Pure,
  no layout.
- `layoutErGraph(nodes, edges)` → nodes with `position {x,y}` via dagre
  (deterministic given input; node size derived from column count).
- `filterErGraph(graph, query)` → the subset of tables whose name (or a column
  name) matches `query`, **plus their FK-neighbors**, and only edges between
  kept nodes. Empty query → full graph.
- `relatedIds(graph, tableId)` → the set of `{tableId} ∪ FK-connected table ids`
  and the connecting edge ids (for click-to-highlight).

### Renderer component — `apps/renderer/src/components/ErDiagram.tsx`

- Loads the graph via IPC, runs `buildErGraph` → `layoutErGraph`, renders a
  React Flow canvas.
- Custom **`TableNode`**: a header (table name) + a list of column rows, each
  with a 🔑 badge for PK and a link badge for FK columns.
- FK **edges** between tables (smoothstep), labeled on hover with
  `fromColumn → toColumn`.
- **Toolbar**: a search box (drives `filterErGraph`), a "fit view" button, and a
  table count.
- **Large-schema guard:** if `tables.length > 60` and the search is empty, show
  a centered notice ("60+ tables — type to filter") instead of rendering
  everything; rendering begins once a filter narrows it.

### IPC + access

- IPC `getSchemaGraph(profileId, database)` (main → engine → renderer), typed in
  `global.d.ts`.
- `SchemaExplorer` database-node context menu gains **"ER 다이어그램"**, which
  opens a new tab in the main content area hosting `ErDiagram` for that database.

## Interactions

- **Pan/zoom** — React Flow built-in (+ a minimap/controls).
- **Search** — filters to matching tables + their FK-neighbors and fits the view.
- **Click a table** — highlight it + FK-connected tables and edges; dim the rest.
  Clicking empty canvas clears the highlight.
- **Double-click a table** — open that table's data view (reuse the existing
  table-data tab flow).
- **Fit view** — recenters/zooms to show the current (filtered) graph.

## Error handling

- Load failure → inline error in the tab with a **Retry** button.
- Empty schema (no tables) → "No tables in this database".
- A table referenced by an FK but absent from the table list (rare/cross-schema)
  → the edge is dropped (only edges between present nodes are kept).

## Testing strategy

- **Pure logic (TDD):**
  - `buildErGraph` — tables → table nodes (with columns/PK), FKs → edges; an FK
    to a missing table is skipped.
  - `layoutErGraph` — every node gets a position; deterministic for the same
    input; no two nodes share a position.
  - `filterErGraph` — name/column match includes the table **and** its
    FK-neighbors; empty query → full graph.
  - `relatedIds` — returns the table + directly FK-connected tables/edges.
- **Integration:** `GET /schema-graph` against live mysql + postgres (throwaway
  tables with an FK), asserting tables, columns/PK, and the FK edge.
- **Live (AGENTS Rule 0, CDP):** open the diagram for dev-mysql, confirm the
  `demo_users` node + columns render; add a throwaway FK'd pair and confirm the
  edge; search to filter; click a table to highlight its neighbors.

## Phasing (sub-projects → issues)

| Phase | Deliverable |
| --- | --- |
| **P1** | Engine `SchemaGraph` (mysql + postgres, TDD integration) + `GET /schema-graph` handler + IPC + types. |
| **P2** | Pure `erGraph.ts` — `buildErGraph` / `layoutErGraph` / `filterErGraph` / `relatedIds` (TDD). Adds `@xyflow/react` + `@dagrejs/dagre`. |
| **P3** | `ErDiagram` + `TableNode` components, toolbar/search, click-highlight, large-schema guard; SchemaExplorer DB-menu → new tab wiring + CSS. |
| **P4** | Live verification (CDP) + docs. |

## Non-goals (YAGNI for v1)

Schema editing / DDL generation from the diagram; persisting custom layouts;
many-to-many junction collapsing; cross-database/cross-schema graphs; exporting
the diagram as an image; Redis.

## Open questions / risks

- **dagre maintenance:** `@dagrejs/dagre` is stable but old; if layout quality is
  poor we can swap to `elkjs` behind the same `layoutErGraph` interface (the
  pure boundary makes this a localized change).
- **React Flow bundle size** adds to the renderer; acceptable for the feature
  value, and it is the standard node/edge canvas.
- **Very wide tables** (many columns) make tall nodes; the large-schema guard +
  search keep the canvas usable, and node height feeds dagre sizing.
