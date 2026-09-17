import type { SchemaGraph, SchemaGraphColumn, SchemaGraphIndex, SchemaGraphTable } from '../global';
import { buildAddColumn, type Driver } from './ddlBuilder';
import { buildCreateIndex } from './indexDdl';

export type SchemaDifferenceKind =
  | 'table-missing'
  | 'table-extra'
  | 'column-missing'
  | 'column-extra'
  | 'column-changed'
  | 'index-missing'
  | 'index-extra'
  | 'foreign-key-missing'
  | 'foreign-key-extra';

export interface SchemaDifference {
  kind: SchemaDifferenceKind;
  table: string;
  object: string;
  detail: string;
  sourceTable?: SchemaGraphTable;
  sourceColumn?: SchemaGraphColumn;
  sourceIndex?: SchemaGraphIndex;
}

export interface SchemaMigrationDraft {
  statements: string[];
  manual: SchemaDifference[];
}

/** Compare source (desired) against target (current); names are matched exactly. */
export function compareSchemaGraphs(source: SchemaGraph, target: SchemaGraph): SchemaDifference[] {
  const sourceTables = new Map(source.tables.map((table) => [table.name, table]));
  const targetTables = new Map(target.tables.map((table) => [table.name, table]));
  const missingTables = [...sourceTables.keys()].filter((name) => !targetTables.has(name)).sort();
  const extraTables = [...targetTables.keys()].filter((name) => !sourceTables.has(name)).sort();
  const commonTables = [...sourceTables.keys()].filter((name) => targetTables.has(name)).sort();
  const differences: SchemaDifference[] = [];

  for (const name of missingTables) {
    const table = sourceTables.get(name)!;
    differences.push({ kind: 'table-missing', table: name, object: name, detail: 'Table exists in source only', sourceTable: table });
  }
  for (const name of extraTables) {
    differences.push({ kind: 'table-extra', table: name, object: name, detail: 'Table exists in target only' });
  }

  for (const tableName of commonTables) {
    const sourceTable = sourceTables.get(tableName)!;
    const targetTable = targetTables.get(tableName)!;
    const sourceColumns = new Map(sourceTable.columns.map((column) => [column.name, column]));
    const targetColumns = new Map(targetTable.columns.map((column) => [column.name, column]));

    for (const name of [...sourceColumns.keys()].filter((column) => !targetColumns.has(column)).sort()) {
      const column = sourceColumns.get(name)!;
      differences.push({
        kind: 'column-missing', table: tableName, object: name,
        detail: `${column.type || 'unknown type'}${column.nullable ? ' NULL' : ' NOT NULL'}${column.defaultValue ? ` DEFAULT ${column.defaultValue}` : ''}`,
        sourceColumn: column,
      });
    }
    for (const name of [...targetColumns.keys()].filter((column) => !sourceColumns.has(column)).sort()) {
      differences.push({ kind: 'column-extra', table: tableName, object: name, detail: 'Column exists in target only' });
    }
    for (const name of [...sourceColumns.keys()].filter((column) => targetColumns.has(column)).sort()) {
      const before = sourceColumns.get(name)!;
      const after = targetColumns.get(name)!;
      const changes: string[] = [];
      if (normalizeType(before.type) !== normalizeType(after.type)) changes.push(`type ${after.type} → ${before.type}`);
      if (before.nullable !== after.nullable) changes.push(`nullable ${after.nullable} → ${before.nullable}`);
      if (before.primaryKey !== after.primaryKey) changes.push(`primary key ${after.primaryKey} → ${before.primaryKey}`);
      if (normalizeExpression(before.defaultValue) !== normalizeExpression(after.defaultValue)) {
        changes.push(`default ${after.defaultValue || '(none)'} → ${before.defaultValue || '(none)'}`);
      }
      if (changes.length) {
        differences.push({ kind: 'column-changed', table: tableName, object: name, detail: changes.join('; '), sourceColumn: before });
      }
    }

    const sourceIndexes = nonPrimaryIndexes(sourceTable.indexes ?? []);
    const targetIndexes = nonPrimaryIndexes(targetTable.indexes ?? []);
    const targetIndexSignatures = new Set(targetIndexes.map(indexSignature));
    const sourceIndexSignatures = new Set(sourceIndexes.map(indexSignature));
    for (const index of sourceIndexes.filter((item) => !targetIndexSignatures.has(indexSignature(item))).sort(byIndexName)) {
      differences.push({ kind: 'index-missing', table: tableName, object: index.name, detail: indexDescription(index), sourceIndex: index });
    }
    for (const index of targetIndexes.filter((item) => !sourceIndexSignatures.has(indexSignature(item))).sort(byIndexName)) {
      differences.push({ kind: 'index-extra', table: tableName, object: index.name, detail: indexDescription(index) });
    }
  }

  const sourceForeignKeysList = source.foreignKeys ?? [];
  const targetForeignKeysList = target.foreignKeys ?? [];
  const targetForeignKeys = new Set(targetForeignKeysList.map(foreignKeySignature));
  const sourceForeignKeys = new Set(sourceForeignKeysList.map(foreignKeySignature));
  for (const fk of sourceForeignKeysList.filter((item) => !targetForeignKeys.has(foreignKeySignature(item))).sort(byForeignKey)) {
    differences.push({
      kind: 'foreign-key-missing', table: fk.fromTable, object: fk.fromColumn,
      detail: `References ${fk.toTable}.${fk.toColumn}`,
    });
  }
  for (const fk of targetForeignKeysList.filter((item) => !sourceForeignKeys.has(foreignKeySignature(item))).sort(byForeignKey)) {
    differences.push({
      kind: 'foreign-key-extra', table: fk.fromTable, object: fk.fromColumn,
      detail: `References ${fk.toTable}.${fk.toColumn}`,
    });
  }

  return differences;
}

/** Draft additive-only SQL. Removals and structural changes are returned for manual review. */
export function generateAdditiveMigration(
  driver: Driver,
  differences: SchemaDifference[],
  createTableDdl: Record<string, string>,
): SchemaMigrationDraft {
  const statements: string[] = [];
  const manual: SchemaDifference[] = [];
  const handled = new Set<SchemaDifference>();
  const addStatement = (statement: string) => {
    const trimmed = statement.trim().replace(/;\s*$/, '');
    if (trimmed && !statements.includes(trimmed)) statements.push(trimmed);
  };

  for (const difference of differences) {
    if (difference.kind !== 'table-missing') continue;
    const ddl = createTableDdl[difference.table]?.trim();
    if (!ddl) continue;
    addStatement(ddl);
    handled.add(difference);
    // MySQL SHOW CREATE TABLE includes secondary indexes. PostgreSQL's table
    // DDL and SQLite's sqlite_master table SQL do not, so add them separately.
    if (driver !== 'mysql') {
      for (const index of (difference.sourceTable?.indexes ?? []).filter((item) => !item.primary)) {
        if (index.partial || index.prefix || index.columns.length === 0 || index.columns.some((column) => !column)) {
          manual.push({
            kind: 'index-missing', table: difference.table, object: index.name,
            detail: `${indexDescription(index)} · index definition requires manual review`, sourceIndex: index,
          });
          continue;
        }
        addStatement(buildCreateIndex(driver, { table: difference.table, ...index }));
      }
    }
  }

  for (const difference of differences) {
    if (difference.kind === 'column-missing') {
      const column = difference.sourceColumn;
      if (!column || column.primaryKey || !column.type.trim() || (!column.nullable && !column.defaultValue?.trim())) continue;
      const [statement] = buildAddColumn(driver, difference.table, {
        name: difference.object,
        type: column.type,
        nullable: column.nullable,
        defaultValue: column.defaultValue,
      });
      addStatement(statement);
      handled.add(difference);
    } else if (difference.kind === 'index-missing') {
      const index = difference.sourceIndex;
      if (!index || index.primary || index.partial || index.prefix || index.columns.length === 0 || index.columns.some((column) => !column)) continue;
      addStatement(buildCreateIndex(driver, { table: difference.table, ...index }));
      handled.add(difference);
    }
  }

  for (const difference of differences) {
    if (!handled.has(difference)) manual.push(difference);
  }
  return { statements, manual };
}

function normalizeType(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeExpression(value?: string): string {
  return (value ?? '').trim().replace(/\s+/g, ' ');
}

function nonPrimaryIndexes(indexes: SchemaGraphIndex[]): SchemaGraphIndex[] {
  return indexes.filter((index) => !index.primary);
}

function indexSignature(index: SchemaGraphIndex): string {
  return `${index.unique ? 1 : 0}:${index.partial ? 1 : 0}:${index.prefix ? 1 : 0}:${index.columns.join('\u0001')}`;
}

function indexDescription(index: SchemaGraphIndex): string {
  return `${index.partial ? 'PARTIAL ' : ''}${index.prefix ? 'PREFIX ' : ''}${index.unique ? 'UNIQUE ' : ''}(${index.columns.join(', ')})`;
}

function foreignKeySignature(fk: SchemaGraph['foreignKeys'][number]): string {
  return `${fk.fromTable}\u0001${fk.fromColumn}\u0001${fk.toTable}\u0001${fk.toColumn}`;
}

function byIndexName(a: SchemaGraphIndex, b: SchemaGraphIndex): number {
  return a.name.localeCompare(b.name);
}

function byForeignKey(a: SchemaGraph['foreignKeys'][number], b: SchemaGraph['foreignKeys'][number]): number {
  return foreignKeySignature(a).localeCompare(foreignKeySignature(b));
}
