import { describe, expect, it } from 'vitest';
import type { SchemaGraph } from '../global';
import { compareSchemaGraphs, generateAdditiveMigration } from './schemaCompare';

const source: SchemaGraph = {
  tables: [
    {
      name: 'users',
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'name', type: 'text', nullable: true, primaryKey: false },
        { name: 'email', type: 'text', nullable: true, primaryKey: false, defaultValue: "'unknown'" },
        { name: 'legacy_code', type: 'text', nullable: false, primaryKey: false },
      ],
      indexes: [
        { name: 'users_pk', columns: ['id'], unique: true, primary: true },
        { name: 'idx_users_email', columns: ['email'], unique: true, primary: false },
      ],
    },
    {
      name: 'projects',
      columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }],
      indexes: [],
    },
    {
      name: 'memberships',
      columns: [
        { name: 'user_id', type: 'INTEGER', nullable: false, primaryKey: false },
        { name: 'project_id', type: 'INTEGER', nullable: false, primaryKey: false },
      ],
      indexes: [],
    },
  ],
  foreignKeys: [{ fromTable: 'memberships', fromColumn: 'user_id', toTable: 'users', toColumn: 'id' }],
};

const target: SchemaGraph = {
  tables: [
    {
      name: 'users',
      columns: [
        { name: 'id', type: 'integer', nullable: false, primaryKey: true },
        { name: 'name', type: 'text', nullable: false, primaryKey: false },
        { name: 'id_old', type: 'integer', nullable: true, primaryKey: false },
      ],
      indexes: [{ name: 'users_name_unique', columns: ['name'], unique: true, primary: false }],
    },
    {
      name: 'memberships',
      columns: [
        { name: 'user_id', type: 'INTEGER', nullable: false, primaryKey: false },
        { name: 'project_id', type: 'INTEGER', nullable: false, primaryKey: false },
      ],
      indexes: [],
    },
    { name: 'audit_log', columns: [], indexes: [] },
  ],
  foreignKeys: [],
};

describe('compareSchemaGraphs', () => {
  it('treats an empty foreign-key payload as an empty list', () => {
    const graph = { tables: [], foreignKeys: null } as unknown as SchemaGraph;
    expect(compareSchemaGraphs(graph, graph)).toEqual([]);
  });

  it('classifies table, column, index, and foreign-key differences directionally', () => {
    const diff = compareSchemaGraphs(source, target);

    expect(diff.map(({ kind, table, object }) => `${kind}:${table}.${object}`)).toEqual([
      'table-missing:projects.projects',
      'table-extra:audit_log.audit_log',
      'column-missing:users.email',
      'column-missing:users.legacy_code',
      'column-extra:users.id_old',
      'column-changed:users.name',
      'index-missing:users.idx_users_email',
      'index-extra:users.users_name_unique',
      'foreign-key-missing:memberships.user_id',
    ]);
  });

  it('treats index names and harmless type casing as non-structural', () => {
    const same: SchemaGraph = {
      tables: [{
        name: 'users',
        columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }],
        indexes: [
          { name: 'other_pk_name', columns: ['id'], unique: true, primary: true },
          { name: 'renamed_email_index', columns: ['email'], unique: true, primary: false },
        ],
      }],
      foreignKeys: [],
    };
    const original: SchemaGraph = {
      tables: [{
        name: 'users',
        columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }],
        indexes: [
          { name: 'users_pkey', columns: ['id'], unique: true, primary: true },
          { name: 'email_index', columns: ['email'], unique: true, primary: false },
        ],
      }],
      foreignKeys: [],
    };
    expect(compareSchemaGraphs(original, same)).toEqual([]);
  });
});

describe('generateAdditiveMigration', () => {
  it('emits only safe additive SQL and keeps removals, modifications, and unsafe columns manual', () => {
    const diff = compareSchemaGraphs(source, target);
    const migration = generateAdditiveMigration('sqlite', diff, {
      projects: 'CREATE TABLE projects (id INTEGER PRIMARY KEY)',
    });

    expect(migration.statements).toEqual([
      'CREATE TABLE projects (id INTEGER PRIMARY KEY)',
      'ALTER TABLE "users" ADD COLUMN "email" text DEFAULT \'unknown\'',
      'CREATE UNIQUE INDEX "idx_users_email" ON "users" ("email")',
    ]);
    expect(migration.manual.map((item) => item.kind)).toEqual([
      'table-extra',
      'column-missing',
      'column-extra',
      'column-changed',
      'index-extra',
      'foreign-key-missing',
    ]);
    expect(migration.statements.join('\n')).not.toMatch(/DROP|ALTER COLUMN/i);
  });

  it('marks missing-table DDL and unsafe new columns as manual instead of inventing SQL', () => {
    const noDefault: SchemaGraph = {
      tables: [{ name: 'account', columns: [{ name: 'required', type: 'TEXT', nullable: false, primaryKey: false }], indexes: [] }],
      foreignKeys: [],
    };
    const existing: SchemaGraph = { tables: [{ name: 'account', columns: [], indexes: [] }], foreignKeys: [] };
    const diffs = compareSchemaGraphs(noDefault, existing);
    const migration = generateAdditiveMigration('sqlite', diffs, {});
    expect(migration.statements).toEqual([]);
    expect(migration.manual.map((item) => item.kind)).toEqual(['column-missing']);
  });
});
