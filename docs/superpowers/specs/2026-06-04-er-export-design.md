# ER Diagram Export — design spec

Follow-up improvement to milestone #6 (read-only ER diagram). Adds the ability to
export the diagram to five formats, chosen from a dropdown.

## Goal

Let the user export the currently-displayed ER graph to **PNG, SVG, SQL DDL,
Mermaid, or DBML** from an **`내보내기 ▾`** dropdown in the ER toolbar.

## Scope (WYSIWYG)

All five formats export the **currently visible table set** — i.e.
`filterErGraph(raw, search)`. With an empty search box that is the full schema;
with a search active it is the matched tables + their FK-neighbors.

- **Images (PNG/SVG)** capture the rendered graph's full bounds. When the schema
  is large enough to be collapsed behind search (`tooLarge`, >60 tables, no
  search), nothing is rendered, so the **image items are disabled**; the three
  text items still work.
- Before an image snapshot, the selection highlight/dim state is cleared so the
  exported picture is clean.

## Formats

| Item | Extension | Source | Notes |
| --- | --- | --- | --- |
| PNG | `.png` | rendered React Flow graph | raster, white background |
| SVG | `.svg` | rendered React Flow graph | vector |
| SQL | `.sql` | engine `get-table-ddl` per table | real `SHOW CREATE TABLE`, runnable |
| Mermaid | `.mmd` | schema graph (pure) | `erDiagram` syntax |
| DBML | `.dbml` | schema graph (pure) | dbdiagram.io syntax |

**Filename:** `{database}-er-{timestamp}.{ext}` using the existing `tsTimestamp()`.

### Mermaid output

```
erDiagram
  users {
    int id PK
    varchar name
  }
  orders {
    int id PK
    int user_id
  }
  orders }o--|| users : user_id
```

Mermaid attribute types must be single tokens — the column type is sanitized
(spaces → `_`, parentheses/commas stripped: `varchar(50)` → `varchar50`,
`double precision` → `double_precision`). Primary keys get the `PK` marker. Each
foreign key becomes a `}o--||` relationship line labeled with the FK column.

### DBML output

```
Table users {
  id int [pk]
  name varchar
}
Table orders {
  id int [pk]
  user_id int
}
Ref: orders.user_id > users.id
```

DBML keeps the raw column type. Primary keys get `[pk]`. Each foreign key becomes
a `Ref:` line.

### SQL DDL output

Concatenate each visible table's real DDL (from the existing `get-table-ddl`
engine endpoint, i.e. `SHOW CREATE TABLE`), separated by blank lines, each
prefixed with a `-- <table>` comment. If a single table's DDL fails to load,
emit `-- failed to load DDL for <table>: <error>` and continue — one failure must
not abort the whole export.

## Architecture / units

- **`apps/renderer/src/lib/erExport.ts`** (pure, TDD) —
  - `toMermaid(graph: SchemaGraph): string`
  - `toDbml(graph: SchemaGraph): string`
  - `joinDdl(parts: { table: string; ddl: string }[]): string`
  - `sanitizeMermaidType(type: string): string` (helper)
- **`apps/renderer/src/lib/erImage.ts`** (thin IO wrapper) —
  - `exportErImage(format: 'png' | 'svg', viewportEl: HTMLElement, nodeBounds): Promise<string>` returns a data URL, using `html-to-image` (`toPng`/`toSvg`) with React Flow's `getNodesBounds` / `getViewportForBounds` to frame the whole graph. Hard to unit-test (canvas/DOM) → live-verified.
- **DDL fetch** — in `ErDiagram.tsx`: for each visible table call `window.electronAPI.getTableDDL(profileId, database, table)`, collect `{ table, ddl }`, then `joinDdl(...)`. Failures become comment lines (above).
- **`ErDiagram.tsx`** — add the `내보내기 ▾` dropdown + per-item handlers wiring the helpers to the existing `download()` helper (and a small data-URL download path for images).

## New dependency

- **`html-to-image`** (React Flow's recommended export library). Text formats add
  no dependencies.

## Error handling

- Export dropdown is disabled when the graph has zero tables.
- Image export wrapped in try/catch; on failure show an inline error message.
- DDL per-table failures degrade to comments (see SQL output).

## Testing

- **TDD (unit):** `toMermaid`, `toDbml`, `joinDdl`, `sanitizeMermaidType` in
  `erExport.test.ts` — including PK markers, FK relationship lines, the
  type-sanitization edge cases, and a DDL failure-comment case.
- **Live CDP verification:** open the ER diagram against the real dev MySQL,
  trigger each of the five export items, assert text content for SQL/Mermaid/DBML,
  assert a non-empty `data:image/...` URL for PNG/SVG, and confirm a search filter
  narrows every format to the visible subset.

## Out of scope

- Native save dialogs (reuse the browser `download` blob/anchor pattern).
- Per-table or selection-only export (always the full visible/filtered set).
- Re-importing any of these formats.
