import { describe, it, expect } from 'vitest';
import { BUILTIN_TEMPLATES } from './builtinTemplates';
import { renderTemplate } from './templateRender';

describe('builtinTemplates', () => {
  it('every template has unique id, a category, description, and params', () => {
    const ids = new Set<string>();
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.id).toBeTruthy();
      expect(ids.has(t.id)).toBe(false);
      ids.add(t.id);
      expect(t.category).toBeTruthy();
      expect(t.description.length).toBeGreaterThan(5);
      expect(t.source).toBe('builtin');
    }
  });

  it('every {{ident}}/:value placeholder in sql has a matching param; every {{role:X}} is declared', () => {
    for (const t of BUILTIN_TEMPLATES) {
      const names = new Set(t.params.map((p) => p.name));
      const noRoles = t.sql.replace(/\{\{role:(\w+)\}\}/g, '');
      for (const m of noRoles.matchAll(/\{\{(\w+)\}\}/g)) expect(names.has(m[1])).toBe(true);
      for (const m of noRoles.matchAll(/:(\w+)/g)) expect(names.has(m[1])).toBe(true);
      for (const m of t.sql.matchAll(/\{\{role:(\w+)\}\}/g)) expect(t.roles).toContain(m[1]);
    }
  });

  it('the dup-by-column template renders against a bound schema', () => {
    const dup = BUILTIN_TEMPLATES.find((t) => t.id === 'dup-by-column')!;
    const r = renderTemplate(dup, {
      driver: 'mysql',
      inputs: { table: 'User', dupColumn: 'phone', tenantValue: '153' },
      roles: { tenant: 'hospitalId', soft_delete: 'deletedAt' },
      validIdentifiers: new Set(['user', 'phone']),
    });
    expect(r.missing).toEqual([]);
    expect(r.sql).toContain('FROM `User`');
  });
});
