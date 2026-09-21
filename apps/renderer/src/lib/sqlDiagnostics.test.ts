import { describe, expect, it } from 'vitest';
import { getSqlDiagnostics } from './sqlDiagnostics';
import type { SchemaInfo } from './sqlCompletion';

const schema: SchemaInfo = {
  tables: [
    { name: 'users', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }] },
  ],
};

describe('getSqlDiagnostics', () => {
  it('does not resolve table names while schema metadata is unavailable', () => {
    const diagnostics = getSqlDiagnostics('SELECT * FROM missing_users;', { tables: [] }, { schemaReady: false });
    expect(diagnostics).toEqual([]);
  });

  it('keeps syntax diagnostics while schema metadata is unavailable', () => {
    const diagnostics = getSqlDiagnostics('SELECT (', { tables: [] }, { schemaReady: false });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: 'error', message: '닫히지 않은 괄호입니다.' });
  });

  it('reports an unknown table at the table token', () => {
    const sql = 'SELECT * FROM missing_users;';
    const [diagnostic] = getSqlDiagnostics(sql, schema);
    expect(diagnostic).toMatchObject({ severity: 'warning', message: '스키마에서 확인되지 않는 테이블: missing_users' });
    expect(sql.slice(diagnostic.start, diagnostic.end)).toBe('missing_users');
  });

  it('still reports unknown tables in DML table positions', () => {
    const queries = [
      'INSERT INTO missing_users (id) VALUES (1);',
      'UPDATE missing_users SET name = \'updated\';',
      'DELETE FROM missing_users;',
    ];

    for (const sql of queries) {
      expect(getSqlDiagnostics(sql, schema).some((item) => item.message.includes('missing_users')), sql).toBe(true);
    }
  });

  it('reports an unknown qualified column while accepting known columns', () => {
    const diagnostics = getSqlDiagnostics('SELECT u.id, u.email FROM users AS u;', schema);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: 'warning', message: '스키마에서 확인되지 않는 컬럼: u.email' });
  });

  it('reports unclosed literals and unbalanced parentheses', () => {
    const literal = getSqlDiagnostics("SELECT ('open", schema);
    expect(literal.some((item) => item.message.includes('문자열'))).toBe(true);
    expect(literal.some((item) => item.message.includes('괄호'))).toBe(true);
  });

  it('ignores table names inside strings and comments', () => {
    const diagnostics = getSqlDiagnostics("SELECT 'FROM missing_users', \"FROM missing_users\", /* FROM missing_users */ name FROM users;", schema);
    expect(diagnostics).toEqual([]);
  });

  it('does not report common database system catalogs as missing tables', () => {
    const catalogQueries = [
      'SELECT SCHEMA_NAME FROM information_schema.schemata;',
      'SELECT datname FROM pg_catalog.pg_database;',
      'SELECT name FROM sys.databases;',
      "SELECT name FROM sqlite_master WHERE type='table';",
    ];

    for (const sql of catalogQueries) {
      expect(getSqlDiagnostics(sql, schema), sql).toEqual([]);
    }
  });

  it('does not report CURRENT_TIMESTAMP as a missing table reference', () => {
    const sqlQueries = [
      'SELECT * FROM CURRENT_TIMESTAMP;',
      'SELECT * FROM CURRENT_DATE;',
      'SELECT * FROM CURRENT_TIME;',
      'SELECT * FROM LOCALTIMESTAMP;',
      'SELECT * FROM LOCALTIME;',
    ];

    for (const sql of sqlQueries) expect(getSqlDiagnostics(sql, schema), sql).toEqual([]);
  });

  it('does not report SQL expressions, generated targets, or clause keywords as tables', () => {
    const sqlQueries = [
      "SELECT $$ FROM missing_users; $$ AS body FROM users;",
      "SELECT * FROM json_each('{}') AS item;",
      'SELECT * FROM json_each AS item;',
      'SELECT * FROM generate_series AS item;',
      "SELECT * FROM LATERAL json_each('{}') AS item;",
      'SELECT * FROM ONLY users;',
      'SELECT * FROM VALUES (1);',
      "INSERT INTO users (id, name) VALUES (1, 'one') ON CONFLICT(id) DO UPDATE SET name = excluded.name;",
      "INSERT INTO users (id, name) VALUES (1, 'one') ON DUPLICATE KEY UPDATE name = VALUES(name);",
      'SELECT id INTO generated_users FROM users;',
      'WITH first_users AS (SELECT id FROM users), second_users AS (SELECT id FROM first_users) SELECT id FROM second_users;',
    ];

    const failures = sqlQueries.flatMap((sql) => {
      const diagnostics = getSqlDiagnostics(sql, schema);
      return diagnostics.length > 0 ? [{ sql, diagnostics }] : [];
    });

    expect(failures).toEqual([]);
  });
});
