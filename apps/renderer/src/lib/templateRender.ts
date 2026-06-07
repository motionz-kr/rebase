import { sqlLiteral } from './dmlBuilder';
import { quoteIdent } from './ddlBuilder';
import type { TemplateDef, TemplateParam, RenderContext, RenderResult } from './templateTypes';

type Resolution = { sql: string } | { missing: string };

function coerceValue(valueType: string | undefined, raw: string): string | number | boolean {
  switch (valueType) {
    case 'number': return Number(raw);
    case 'boolean': return raw === 'true' || raw === '1';
    default: return raw;
  }
}

function resolveParam(p: TemplateParam, ctx: RenderContext): Resolution {
  const raw = (ctx.inputs[p.name] ?? p.default ?? '').trim();
  if (p.kind === 'value') {
    if (raw === '') return { missing: p.name };
    return { sql: sqlLiteral(ctx.driver, coerceValue(p.valueType, raw)) };
  }
  if (p.kind === 'identifier') {
    if (raw === '' || !ctx.validIdentifiers.has(raw.toLowerCase())) return { missing: p.name };
    return { sql: quoteIdent(ctx.driver, raw) };
  }
  if (raw === '') return { missing: p.name };
  const opt = (p.options ?? []).find((o) => (o.value ?? o.label) === raw);
  if (!opt) return { missing: p.name };
  if (opt.sqlFragment != null) return { sql: opt.sqlFragment };
  return { sql: sqlLiteral(ctx.driver, opt.value ?? '') };
}

function resolveRole(role: string, ctx: RenderContext): Resolution {
  const col = ctx.roles[role];
  if (!col) return { missing: `role:${role}` };
  return { sql: quoteIdent(ctx.driver, col) };
}

function buildResolutions(def: TemplateDef, ctx: RenderContext) {
  const params = new Map<string, Resolution>();
  for (const p of def.params) params.set(p.name, resolveParam(p, ctx));
  const roles = new Map<string, Resolution>();
  for (const role of def.roles) roles.set(role, resolveRole(role, ctx));
  return { params, roles };
}

const RE_ROLE = /\{\{role:(\w+)\}\}/g;
const RE_IDENT = /\{\{(\w+)\}\}/g;
const RE_VALUE = /:(\w+)/g;

function fragmentResolves(fragment: string, res: ReturnType<typeof buildResolutions>): boolean {
  const names = new Set<string>();
  for (const m of fragment.matchAll(RE_ROLE)) names.add('role:' + m[1]);
  const noRoles = fragment.replace(RE_ROLE, '');
  for (const m of noRoles.matchAll(RE_IDENT)) names.add('ident:' + m[1]);
  for (const m of noRoles.matchAll(RE_VALUE)) names.add('value:' + m[1]);
  for (const key of names) {
    const idx = key.indexOf(':');
    const kind = key.slice(0, idx);
    const name = key.slice(idx + 1);
    if (kind === 'role') {
      const r = res.roles.get(name);
      if (!r || 'missing' in r) return false;
    } else {
      const r = res.params.get(name);
      if (!r || 'missing' in r) return false;
    }
  }
  return true;
}

function substitute(fragment: string, res: ReturnType<typeof buildResolutions>): string {
  let out = fragment.replace(RE_ROLE, (_, role) => {
    const r = res.roles.get(role);
    return r && 'sql' in r ? r.sql : '';
  });
  out = out.replace(RE_IDENT, (_, name) => {
    const r = res.params.get(name);
    return r && 'sql' in r ? r.sql : '';
  });
  out = out.replace(RE_VALUE, (_, name) => {
    const r = res.params.get(name);
    return r && 'sql' in r ? r.sql : '';
  });
  return out;
}

const RE_BLOCK = /\[\[([\s\S]*?)\]\]/g;

export function renderTemplate(def: TemplateDef, ctx: RenderContext): RenderResult {
  const res = buildResolutions(def, ctx);

  let sql = def.sql.replace(RE_BLOCK, (_, inner) =>
    fragmentResolves(inner, res) ? substitute(inner, res) : '',
  );
  sql = substitute(sql, res);
  sql = sql.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  const outsideOnly = def.sql.replace(RE_BLOCK, '');
  const missing: string[] = [];
  for (const p of def.params) {
    if (!p.required) continue;
    const referencedOutside =
      outsideOnly.includes(`{{${p.name}}}`) || new RegExp(`:${p.name}\\b`).test(outsideOnly);
    const r = res.params.get(p.name);
    if (referencedOutside && r && 'missing' in r) missing.push(p.name);
  }
  for (const role of def.roles) {
    const referencedOutside = outsideOnly.includes(`{{role:${role}}}`);
    const r = res.roles.get(role);
    if (referencedOutside && r && 'missing' in r) missing.push(`role:${role}`);
  }
  return { sql, missing };
}
