import type { Driver } from './ddlBuilder';

export type ParamKind = 'value' | 'identifier' | 'enum';

export interface TemplateParam {
  name: string;
  label: string;
  kind: ParamKind;
  valueType?: 'string' | 'number' | 'date' | 'boolean';
  identifierKind?: 'table' | 'column';
  role?: string;
  required?: boolean;
  default?: string;
  options?: { label: string; value?: string; sqlFragment?: string }[];
}

export interface TemplateDef {
  id: string;
  name: string;
  description: string;
  category: string;
  sql: string;
  params: TemplateParam[];
  roles: string[];
  driver?: string;
  source: 'builtin' | 'user';
}

export interface RenderContext {
  driver: Driver;
  inputs: Record<string, string>;     // user form values keyed by param name
  roles: Record<string, string>;      // role -> column name (domainBindings)
  validIdentifiers: Set<string>;      // lowercased real table+column names
}

export interface RenderResult {
  sql: string;
  missing: string[];                  // required params/roles not satisfied
}
