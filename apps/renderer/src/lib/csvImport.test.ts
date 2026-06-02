import { describe, it, expect } from 'vitest';
import { autoMapColumns, buildImportStatements } from './csvImport';

describe('autoMapColumns', () => {
  it('matches table columns to CSV header indices case-insensitively', () => {
    expect(autoMapColumns(['id', 'name', 'extra'], ['Name', 'ID'])).toEqual({ id: 1, name: 0 });
  });
});

describe('buildImportStatements', () => {
  const spec = { table: 't', mapping: { id: 0, name: 1 }, colTypes: { id: 'int', name: 'varchar(50)' } };
  it('builds a typed multi-row insert; empty cell → NULL', () => {
    expect(buildImportStatements('mysql', spec, [['1', 'Al'], ['2', '']])).toEqual([
      "INSERT INTO `t` (`id`, `name`) VALUES (1, 'Al'), (2, NULL)",
    ]);
  });
  it('chunks rows by chunkSize', () => {
    const s = { ...spec, chunkSize: 1 };
    expect(buildImportStatements('mysql', s, [['1', 'a'], ['2', 'b']])).toEqual([
      "INSERT INTO `t` (`id`, `name`) VALUES (1, 'a')",
      "INSERT INTO `t` (`id`, `name`) VALUES (2, 'b')",
    ]);
  });
  it('returns [] when no mapping or no rows', () => {
    expect(buildImportStatements('mysql', { table: 't', mapping: {}, colTypes: {} }, [['1']])).toEqual([]);
    expect(buildImportStatements('mysql', spec, [])).toEqual([]);
  });
});
