import { describe, it, expect } from 'vitest';
import { sanitizeMermaidType, toMermaid, toDbml, joinDdl } from './erExport';
import type { SchemaGraph } from '../global';

const g: SchemaGraph = {
  tables: [
    { name: 'users', columns: [{ name: 'id', type: 'int', nullable: false, primaryKey: true }] },
    {
      name: 'orders',
      columns: [
        { name: 'id', type: 'int', nullable: false, primaryKey: true },
        { name: 'user_id', type: 'int', nullable: true, primaryKey: false },
        { name: 'note', type: 'varchar(50)', nullable: true, primaryKey: false },
      ],
    },
  ],
  foreignKeys: [{ fromTable: 'orders', fromColumn: 'user_id', toTable: 'users', toColumn: 'id' }],
};

describe('sanitizeMermaidType', () => {
  it('strips parens/commas and collapses spaces', () => {
    expect(sanitizeMermaidType('varchar(50)')).toBe('varchar50');
    expect(sanitizeMermaidType('double precision')).toBe('double_precision');
    expect(sanitizeMermaidType('')).toBe('unknown');
  });
});

describe('toMermaid', () => {
  it('emits erDiagram with PK markers and a relationship line', () => {
    const out = toMermaid(g);
    expect(out).toContain('erDiagram');
    expect(out).toContain('int id PK');
    expect(out).toContain('varchar50 note');
    expect(out).toContain('orders }o--|| users : "user_id"');
  });
  it('skips an FK referencing a table not in the set', () => {
    const g2: SchemaGraph = {
      tables: g.tables,
      foreignKeys: [{ fromTable: 'orders', fromColumn: 'x', toTable: 'ghost', toColumn: 'id' }],
    };
    expect(toMermaid(g2)).not.toContain('ghost');
  });
});

describe('toDbml', () => {
  it('emits Table blocks with [pk] and a Ref line', () => {
    const out = toDbml(g);
    expect(out).toContain('Table users {');
    expect(out).toContain('id int [pk]');
    expect(out).toContain('Ref: orders.user_id > users.id');
  });
  it('quotes types containing spaces', () => {
    const g2: SchemaGraph = {
      tables: [
        { name: 't', columns: [{ name: 'c', type: 'timestamp without time zone', nullable: true, primaryKey: false }] },
      ],
      foreignKeys: [],
    };
    expect(toDbml(g2)).toContain('c "timestamp without time zone"');
  });
});

describe('joinDdl', () => {
  it('joins DDL parts with table comments and a single trailing semicolon', () => {
    const out = joinDdl([{ table: 'users', ddl: 'CREATE TABLE users (id int)' }]);
    expect(out).toContain('-- users');
    expect(out).toContain('CREATE TABLE users (id int);');
  });
  it('renders failures as comments without aborting', () => {
    const out = joinDdl([
      { table: 'users', ddl: 'CREATE TABLE users (id int);' },
      { table: 'bad', error: 'boom' },
    ]);
    expect(out).toContain('-- failed to load DDL for bad: boom');
    expect(out).toContain('CREATE TABLE users (id int);');
  });
});
