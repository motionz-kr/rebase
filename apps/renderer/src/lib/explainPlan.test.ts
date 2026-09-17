import { describe, expect, it } from 'vitest';
import { buildExplainSql, parseExplainPlan } from './explainPlan';

describe('buildExplainSql', () => {
  it('uses non-executing, driver-appropriate explain statements', () => {
    expect(buildExplainSql('postgres', 'SELECT * FROM users')).toBe('EXPLAIN (FORMAT JSON) SELECT * FROM users');
    expect(buildExplainSql('mysql', 'SELECT * FROM users')).toBe('EXPLAIN FORMAT=JSON SELECT * FROM users');
    expect(buildExplainSql('sqlite', 'SELECT * FROM users')).toBe('EXPLAIN QUERY PLAN SELECT * FROM users');
  });

  it('does not claim visual plan support for drivers without a supported formatter', () => {
    expect(buildExplainSql('sqlserver', 'SELECT * FROM users')).toBeNull();
    expect(buildExplainSql('redis', 'GET user:1')).toBeNull();
  });

  it('rejects empty or multi-statement input rather than explaining only a prefix', () => {
    expect(buildExplainSql('sqlite', '  ')).toBeNull();
    expect(buildExplainSql('sqlite', 'SELECT 1; SELECT 2')).toBeNull();
  });
});

describe('parseExplainPlan', () => {
  it('parses nested PostgreSQL JSON plans and exposes estimates', () => {
    const rows = [[{
      Plan: {
        'Node Type': 'Seq Scan',
        'Relation Name': 'users',
        'Startup Cost': 0,
        'Total Cost': 35.5,
        'Plan Rows': 12,
        'Plan Width': 64,
        Plans: [{
          'Node Type': 'Index Scan',
          'Index Name': 'orders_user_id_idx',
          'Relation Name': 'orders',
          'Startup Cost': 0.2,
          'Total Cost': 4.8,
          'Plan Rows': 2,
          'Plan Width': 24,
        }],
      },
    }]];

    expect(parseExplainPlan('postgres', ['QUERY PLAN'], rows)).toEqual({
      roots: [{
        operation: 'Seq Scan',
        details: ['users', 'cost 0..35.5', '12 rows', 'width 64'],
        children: [{
          operation: 'Index Scan',
          details: ['orders', 'orders_user_id_idx', 'cost 0.2..4.8', '2 rows', 'width 24'],
          children: [],
        }],
      }],
      format: 'PostgreSQL',
    });
  });

  it('parses MySQL JSON query blocks, nested loops, and table access details', () => {
    const rows = [[JSON.stringify({
      query_block: {
        select_id: 1,
        cost_info: { query_cost: '0.35' },
        nested_loop: [
          { table: { table_name: 'customers', access_type: 'ALL', rows_examined_per_scan: 12, filtered: '100.00' } },
          { table: { table_name: 'orders', access_type: 'ref', key: 'customer_id', rows_examined_per_scan: 2, ref: ['customers.id'] } },
        ],
      },
    })]];

    const plan = parseExplainPlan('mysql', ['EXPLAIN'], rows);
    expect(plan?.format).toBe('MySQL');
    expect(plan?.roots[0].operation).toBe('Query block');
    const operations = flattenOperations(plan?.roots ?? []);
    expect(operations).toContain('Nested loop');
    expect(operations).toContain('Table: customers');
    expect(operations).toContain('Table: orders');
    expect(JSON.stringify(plan)).toContain('customer_id');
  });

  it('builds SQLite plan hierarchy from the parent id column', () => {
    const plan = parseExplainPlan('sqlite', ['id', 'parent', 'notused', 'detail'], [
      [2, 0, 0, 'SCAN users'],
      [5, 2, 0, 'SEARCH orders USING INDEX orders_user_id_idx (user_id=?)'],
    ]);

    expect(plan).toEqual({
      roots: [{
        operation: 'SCAN users',
        details: ['id 2'],
        children: [{
          operation: 'SEARCH orders USING INDEX orders_user_id_idx (user_id=?)',
          details: ['id 5'],
          children: [],
        }],
      }],
      format: 'SQLite',
    });
  });

  it('returns null for unsupported or unrecognized result shapes', () => {
    expect(parseExplainPlan('sqlserver', ['Plan'], [['<ShowPlanXML/>']])).toBeNull();
    expect(parseExplainPlan('postgres', ['QUERY PLAN'], [['not json']])).toBeNull();
  });
});

function flattenOperations(roots: Array<{ operation: string; children: Array<{ operation: string; children: unknown[] }> }>): string[] {
  return roots.flatMap((node) => [node.operation, ...flattenOperations(node.children as typeof roots)]);
}
