import dagre from '@dagrejs/dagre';
import type { SchemaGraph, SchemaGraphTable } from '../global';

export interface ErNode {
  id: string;
  type: 'table';
  position: { x: number; y: number };
  data: { name: string; columns: SchemaGraphTable['columns']; dimmed?: boolean };
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

// Tables → table nodes (with columns), FKs → edges. An FK to/from a table not in
// the table list is skipped (e.g. cross-schema references).
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
// FK-neighbors, and only FKs between kept tables. Empty query → the full graph.
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
  for (const e of buildErGraph(g).edges) {
    if (e.source === tableId || e.target === tableId) {
      tables.add(e.source);
      tables.add(e.target);
      edges.add(e.id);
    }
  }
  return { tables, edges };
}

const NODE_W = 220;
const ROW_H = 22;
const HEADER_H = 34;

// Deterministic left-to-right layout via dagre; node height scales with column
// count. Positions are top-left (React Flow convention).
export function layoutErGraph(graph: ErGraph): ErGraph {
  const d = new dagre.graphlib.Graph();
  d.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 90 });
  d.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) {
    d.setNode(n.id, { width: NODE_W, height: HEADER_H + n.data.columns.length * ROW_H });
  }
  for (const e of graph.edges) d.setEdge(e.source, e.target);
  dagre.layout(d);
  const nodes = graph.nodes.map((n) => {
    const p = d.node(n.id);
    const h = HEADER_H + n.data.columns.length * ROW_H;
    return { ...n, position: { x: p.x - NODE_W / 2, y: p.y - h / 2 } };
  });
  return { nodes, edges: graph.edges };
}
