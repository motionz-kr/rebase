import { splitStatementRanges } from './splitStatements';

export type ExplainDriver = 'mysql' | 'postgres' | 'sqlite' | 'sqlserver' | 'redis';

export interface ExplainPlanNode {
  operation: string;
  details: string[];
  children: ExplainPlanNode[];
}

export interface ExplainPlan {
  roots: ExplainPlanNode[];
  format: 'PostgreSQL' | 'MySQL' | 'SQLite';
}

/** Build a read-only explain statement for the drivers with a supported plan format. */
export function buildExplainSql(driver: ExplainDriver, sql: string): string | null {
  const ranges = splitStatementRanges(sql);
  if (ranges.length !== 1) return null;
  const statement = ranges[0].statement.trim().replace(/;\s*$/, '');
  if (!statement) return null;

  if (driver === 'postgres') return `EXPLAIN (FORMAT JSON) ${statement}`;
  if (driver === 'mysql') return `EXPLAIN FORMAT=JSON ${statement}`;
  if (driver === 'sqlite') return `EXPLAIN QUERY PLAN ${statement}`;
  return null;
}

/** Convert supported driver output to a display-only, driver-neutral tree. */
export function parseExplainPlan(driver: ExplainDriver, columns: string[], rows: unknown[][]): ExplainPlan | null {
  if (driver === 'sqlite') return parseSqlitePlan(columns, rows);
  if (driver === 'postgres' || driver === 'mysql') {
    const payload = parseJsonCell(rows);
    if (payload == null) return null;
    return driver === 'postgres' ? parsePostgresPlan(payload) : parseMysqlPlan(payload);
  }
  return null;
}

function parseJsonCell(rows: unknown[][]): unknown {
  if (!rows.length || !rows[0]?.length) return null;
  let cell = rows[0][0];
  if (cell instanceof Uint8Array) cell = new TextDecoder().decode(cell);
  if (typeof cell === 'string') {
    try {
      return JSON.parse(cell) as unknown;
    } catch {
      return null;
    }
  }
  return cell;
}

function parsePostgresPlan(payload: unknown): ExplainPlan | null {
  const candidates = Array.isArray(payload) ? payload : [payload];
  const roots = candidates.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const root = candidate.Plan ?? candidate.plan ?? candidate;
    const node = postgresNode(root);
    return node ? [node] : [];
  });
  return roots.length ? { roots, format: 'PostgreSQL' } : null;
}

function postgresNode(value: unknown): ExplainPlanNode | null {
  if (!isRecord(value)) return null;
  const operation = stringValue(value['Node Type'] ?? value['node type']);
  if (!operation) return null;

  const details: string[] = [];
  const relation = value['Relation Name'] ?? value['relation name'];
  const index = value['Index Name'] ?? value['index name'];
  if (relation != null) details.push(String(relation));
  if (index != null) details.push(String(index));

  const startupCost = value['Startup Cost'] ?? value['startup cost'];
  const totalCost = value['Total Cost'] ?? value['total cost'];
  if (startupCost != null && totalCost != null) details.push(`cost ${startupCost}..${totalCost}`);
  const planRows = value['Plan Rows'] ?? value['plan rows'];
  if (planRows != null) details.push(`${planRows} rows`);
  const width = value['Plan Width'] ?? value['plan width'];
  if (width != null) details.push(`width ${width}`);

  for (const [field, label] of [['Actual Rows', 'actual rows'], ['Actual Total Time', 'actual ms'], ['Actual Loops', 'loops']] as const) {
    const actual = value[field] ?? value[field.toLowerCase()];
    if (actual != null) details.push(`${label} ${actual}`);
  }

  const planChildren = value.Plans ?? value.plans;
  const children = Array.isArray(planChildren)
    ? planChildren.map(postgresNode).filter((node): node is ExplainPlanNode => node !== null)
    : [];
  return { operation, details, children };
}

function parseMysqlPlan(payload: unknown): ExplainPlan | null {
  if (!isRecord(payload)) return null;
  const roots = Object.entries(payload).flatMap(([key, value]) => mysqlNodes(value, key));
  return roots.length ? { roots, format: 'MySQL' } : null;
}

const MYSQL_OPERATIONS: Record<string, string> = {
  query_block: 'Query block',
  nested_loop: 'Nested loop',
  ordering_operation: 'Ordering',
  grouping_operation: 'Grouping',
  duplicates_removal: 'Duplicate removal',
  union_result: 'Union result',
  query_specifications: 'Query specifications',
  materialized_from_subquery: 'Materialized subquery',
  having_subqueries: 'HAVING subqueries',
  attached_subqueries: 'Attached subqueries',
  optimized_away_subqueries: 'Optimized subqueries',
};

function mysqlNodes(value: unknown, key: string): ExplainPlanNode[] {
  if (Array.isArray(value)) return value.flatMap((item) => mysqlNodes(item, key));
  if (!isRecord(value)) return [];

  const operation = key === 'table'
    ? `Table: ${stringValue(value.table_name ?? value.table ?? '(unknown)')}`
    : MYSQL_OPERATIONS[key] ?? (key === 'cost_info' ? 'Cost' : humanizeKey(key));
  const children: ExplainPlanNode[] = [];
  const details: string[] = [];
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === 'table_name') continue;
    if (childKey === 'cost_info') {
      details.push(...flattenScalars(childValue, 'cost'));
    } else if (isRecord(childValue) || Array.isArray(childValue)) {
      children.push(...mysqlNodes(childValue, childKey));
    } else if (childValue != null) {
      details.push(`${humanizeKey(childKey)} ${String(childValue)}`);
    }
  }

  return [{ operation, details, children }];
}

function flattenScalars(value: unknown, prefix: string): string[] {
  if (!isRecord(value)) return value == null ? [] : [`${prefix} ${String(value)}`];
  return Object.entries(value).flatMap(([key, child]) => flattenScalars(child, `${prefix} ${humanizeKey(key)}`));
}

function parseSqlitePlan(columns: string[], rows: unknown[][]): ExplainPlan | null {
  const normalizedColumns = columns.map((column) => column.toLowerCase());
  const idIndex = normalizedColumns.indexOf('id');
  const parentIndex = normalizedColumns.indexOf('parent');
  const detailIndex = normalizedColumns.indexOf('detail');
  if (idIndex < 0 || parentIndex < 0 || detailIndex < 0 || !rows.length) return null;

  const nodes = new Map<string, ExplainPlanNode>();
  const parents = new Map<string, string>();
  for (const row of rows) {
    const id = stringValue(row[idIndex]);
    const detail = stringValue(row[detailIndex]);
    if (!id || !detail) continue;
    nodes.set(id, { operation: detail, details: [`id ${id}`], children: [] });
    parents.set(id, stringValue(row[parentIndex]));
  }
  if (!nodes.size) return null;

  const roots: ExplainPlanNode[] = [];
  for (const [id, node] of nodes) {
    const parentId = parents.get(id);
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return { roots, format: 'SQLite' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function stringValue(value: unknown): string {
  return value == null ? '' : String(value);
}

function humanizeKey(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
