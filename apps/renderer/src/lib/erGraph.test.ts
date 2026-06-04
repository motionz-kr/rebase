import { describe, it, expect } from 'vitest';
import { buildErGraph, filterErGraph, relatedIds, layoutErGraph } from './erGraph';
import type { SchemaGraph } from '../global';

const g: SchemaGraph = {
  tables: [
    { name: 'users', columns: [{ name: 'id', type: 'int', nullable: false, primaryKey: true }] },
    {
      name: 'orders',
      columns: [
        { name: 'id', type: 'int', nullable: false, primaryKey: true },
        { name: 'user_id', type: 'int', nullable: true, primaryKey: false },
      ],
    },
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
    const bad: SchemaGraph = {
      tables: g.tables,
      foreignKeys: [{ fromTable: 'orders', fromColumn: 'x', toTable: 'ghost', toColumn: 'id' }],
    };
    expect(buildErGraph(bad).edges).toHaveLength(0);
  });
});

describe('filterErGraph', () => {
  it('empty query returns the full graph', () => {
    expect(filterErGraph(g, '').tables).toHaveLength(3);
  });
  it('matches a table name and includes FK-neighbors', () => {
    const out = filterErGraph(g, 'orders');
    expect(out.tables.map((t) => t.name).sort()).toEqual(['orders', 'users']);
  });
  it('matches a column name', () => {
    expect(filterErGraph(g, 'user_id').tables.map((t) => t.name).sort()).toEqual(['orders', 'users']);
  });
});

describe('relatedIds', () => {
  it('returns the table plus FK-connected tables and edge ids', () => {
    const r = relatedIds(g, 'users');
    expect([...r.tables].sort()).toEqual(['orders', 'users']);
    expect(r.edges.size).toBe(1);
  });
});

describe('layoutErGraph', () => {
  it('assigns a unique finite position to every node', () => {
    const laid = layoutErGraph(buildErGraph(g));
    expect(laid.nodes).toHaveLength(3);
    for (const n of laid.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
    const keys = new Set(laid.nodes.map((n) => `${n.position.x},${n.position.y}`));
    expect(keys.size).toBe(3);
  });
});
