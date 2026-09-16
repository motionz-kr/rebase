import { describe, expect, it } from 'vitest';
import { getSqlDiagnostics } from './sqlDiagnostics';
import type { SchemaInfo } from './sqlCompletion';

const schema: SchemaInfo = {
  tables: [
    { name: 'users', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'TEXT' }] },
  ],
};

describe('getSqlDiagnostics', () => {
  it('reports an unknown table at the table token', () => {
    const sql = 'SELECT * FROM missing_users;';
    const [diagnostic] = getSqlDiagnostics(sql, schema);
    expect(diagnostic).toMatchObject({ severity: 'error', message: '테이블을 찾을 수 없습니다: missing_users' });
    expect(sql.slice(diagnostic.start, diagnostic.end)).toBe('missing_users');
  });

  it('reports an unknown qualified column while accepting known columns', () => {
    const diagnostics = getSqlDiagnostics('SELECT u.id, u.email FROM users AS u;', schema);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ severity: 'error', message: '컬럼을 찾을 수 없습니다: u.email' });
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
});
