# ER Diagram — operating notes

The ER (entity-relationship) diagram is a **read-only** visualization of a
database's tables and their foreign-key relationships. It renders with
[React Flow] and lays out automatically with [dagre]. MySQL and PostgreSQL only
(Redis has no relational schema).

## Opening it

Connect to a MySQL/PostgreSQL profile, then right-click a database in the schema
explorer and choose **ER 다이어그램**. It opens in the connection's content area
(replacing the table view / query editor); use **쿼리로 돌아가기** on a table tab
or reopen the query editor to switch back.

The diagram is one tab per connection. Opening a different database's diagram, or
opening a table's data view, replaces it.

## What it shows

- **One card per table** — the table name as a header, then each column with its
  type. Primary-key columns are marked with 🔑.
- **One edge per foreign key** — drawn from the referencing table to the
  referenced table.
- **Toolbar** — a table/column search box, the table count, and a **맞춤** button
  that re-fits the graph to the viewport.

## Interactions

| Action | Result |
| --- | --- |
| **Search** | Filters to tables whose name or any column matches, plus their direct FK-neighbors. Clearing the box restores the full graph. |
| **Click a node** | Highlights that table's FK edges and dims everything unrelated. Click the background to clear. |
| **Double-click a node** | Opens that table's data view. |
| **Scroll / drag** | Zoom and pan (a minimap and zoom controls are provided). Nodes are not draggable — the layout is deterministic. |

Large schemas (more than 60 tables) start collapsed with a prompt to search,
since laying out hundreds of nodes at once is rarely useful; typing in the search
box reveals the matching subset.

## How it works

```
renderer ──IPC get-schema-graph──▶ main ──GET /schema-graph──▶ engine
                                                                  │
                                          information_schema queries (columns + FKs)
```

- **Engine** (`GET /schema-graph?profileId=…&database=…`) — the
  `SQLConnector.GetSchemaGraph` adapter method runs two `information_schema`
  queries (columns with PK/nullable flags, and foreign keys) and returns a
  `{ tables, foreignKeys }` graph. Implemented for both the MySQL and PostgreSQL
  adapters.
- **Renderer** — pure helpers in `apps/renderer/src/lib/erGraph.ts`
  (`buildErGraph` / `filterErGraph` / `relatedIds` / `layoutErGraph`) turn the
  graph into React Flow nodes/edges and a dagre layout. They are unit-tested in
  `erGraph.test.ts`. `ErDiagram.tsx` is the component shell.

Because it only reads `information_schema`, the diagram never mutates data and is
safe to open against any connection.

[React Flow]: https://reactflow.dev/
[dagre]: https://github.com/dagrejs/dagre
