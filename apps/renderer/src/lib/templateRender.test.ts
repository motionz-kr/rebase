import { describe, it, expect } from 'vitest';
import { renderTemplate } from './templateRender';
import type { TemplateDef, RenderContext } from './templateTypes';

const dupDef: TemplateDef = {
  id: 'dup', name: 'dup', description: '', category: 'CS', source: 'builtin',
  roles: ['tenant', 'soft_delete'],
  sql: `SELECT {{dupCol}}, COUNT(*) c FROM {{table}}
WHERE {{dupCol}} IS NOT NULL
[[ AND {{role:tenant}} = :tenantValue ]]
[[ AND {{role:soft_delete}} IS NULL ]]
GROUP BY {{dupCol}} HAVING COUNT(*) > 1`,
  params: [
    { name: 'table', label: 'Table', kind: 'identifier', identifierKind: 'table', required: true },
    { name: 'dupCol', label: 'Column', kind: 'identifier', identifierKind: 'column', required: true },
    { name: 'tenantValue', label: 'Tenant value', kind: 'value', valueType: 'number' },
  ],
};

function ctx(over: Partial<RenderContext>): RenderContext {
  return {
    driver: 'mysql',
    inputs: {},
    roles: {},
    validIdentifiers: new Set(['user', 'phone', 'hospitalid', 'deletedat']),
    ...over,
  };
}

describe('renderTemplate', () => {
  it('substitutes identifiers + value, keeps optional blocks when resolved', () => {
    const r = renderTemplate(dupDef, ctx({
      inputs: { table: 'User', dupCol: 'phone', tenantValue: '153' },
      roles: { tenant: 'hospitalId', soft_delete: 'deletedAt' },
    }));
    expect(r.missing).toEqual([]);
    expect(r.sql).toContain('SELECT `phone`, COUNT(*) c FROM `User`');
    expect(r.sql).toContain('AND `hospitalId` = 153');
    expect(r.sql).toContain('AND `deletedAt` IS NULL');
  });

  it('drops optional block when role unbound', () => {
    const r = renderTemplate(dupDef, ctx({
      inputs: { table: 'User', dupCol: 'phone' },
      roles: {},
    }));
    expect(r.sql).not.toContain('hospital');
    expect(r.sql).not.toContain('IS NULL');
    expect(r.sql).toContain('FROM `User`');
  });

  it('drops tenant block when value empty even if role bound', () => {
    const r = renderTemplate(dupDef, ctx({
      inputs: { table: 'User', dupCol: 'phone' },
      roles: { tenant: 'hospitalId' },
    }));
    expect(r.sql).not.toContain('hospitalId =');
  });

  it('reports missing required identifier', () => {
    const r = renderTemplate(dupDef, ctx({ inputs: { dupCol: 'phone' } }));
    expect(r.missing).toContain('table');
  });

  it('rejects an identifier not in the schema', () => {
    const r = renderTemplate(dupDef, ctx({ inputs: { table: 'Secret', dupCol: 'phone' } }));
    expect(r.missing).toContain('table');
  });

  it('escapes string values', () => {
    const def: TemplateDef = { ...dupDef, roles: [], sql: `WHERE name = :name`,
      params: [{ name: 'name', label: 'n', kind: 'value', valueType: 'string', required: true }] };
    const r = renderTemplate(def, ctx({ inputs: { name: "a'b" } }));
    expect(r.sql).toContain("name = 'a''b'");
  });

  it('treats a non-numeric value for a number param as missing', () => {
    const def: TemplateDef = { ...dupDef, roles: [], sql: `WHERE id = :id`,
      params: [{ name: 'id', label: 'id', kind: 'value', valueType: 'number', required: true }] };
    const r = renderTemplate(def, ctx({ inputs: { id: 'abc' } }));
    expect(r.missing).toContain('id');
    expect(r.sql).not.toContain('NaN');
  });

  it('accepts a valid number', () => {
    const def: TemplateDef = { ...dupDef, roles: [], sql: `WHERE id = :id`,
      params: [{ name: 'id', label: 'id', kind: 'value', valueType: 'number', required: true }] };
    const r = renderTemplate(def, ctx({ inputs: { id: '42' } }));
    expect(r.missing).toEqual([]);
    expect(r.sql).toContain('id = 42');
  });

  it('does not treat a ::type cast as a value param', () => {
    const def: TemplateDef = { ...dupDef, roles: [], sql: `SELECT created::date FROM {{table}} WHERE id = :id`,
      params: [
        { name: 'table', label: 't', kind: 'identifier', identifierKind: 'table', required: true },
        { name: 'id', label: 'id', kind: 'value', valueType: 'number', required: true },
      ] };
    const r = renderTemplate(def, ctx({ inputs: { table: 'User', id: '7' }, validIdentifiers: new Set(['user']) }));
    expect(r.sql).toContain('created::date');   // cast preserved, not blanked
    expect(r.sql).toContain('WHERE id = 7');
  });
});
