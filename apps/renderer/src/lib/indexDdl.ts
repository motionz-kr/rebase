import { quoteIdent, type Driver } from './ddlBuilder';

export interface CreateIndexSpec {
  table: string;
  name: string;
  columns: string[];
  unique: boolean;
}

// CREATE [UNIQUE] INDEX <name> ON <table> (<cols>). Identifiers quoted per driver.
export function buildCreateIndex(driver: Driver, spec: CreateIndexSpec): string {
  const cols = spec.columns.map((c) => quoteIdent(driver, c)).join(', ');
  const unique = spec.unique ? 'UNIQUE ' : '';
  return `CREATE ${unique}INDEX ${quoteIdent(driver, spec.name)} ON ${quoteIdent(driver, spec.table)} (${cols})`;
}

// DROP INDEX. MySQL scopes by table; PostgreSQL drops by index name alone.
export function buildDropIndex(driver: Driver, spec: { table: string; name: string }): string {
  if (driver === 'mysql') {
    return `DROP INDEX ${quoteIdent(driver, spec.name)} ON ${quoteIdent(driver, spec.table)}`;
  }
  return `DROP INDEX ${quoteIdent(driver, spec.name)}`;
}
