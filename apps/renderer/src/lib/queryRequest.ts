export interface SqlQueryRequest {
  profileId: string;
  database: string;
  sql: string;
  execute: boolean;
  nonce: number;
  /** Open schema-explorer actions in a new database-bound query tab. */
  openInNewTab?: boolean;
}

export function createSqlQueryRequest(
  profileId: string,
  database: string,
  sql: string,
  execute: boolean,
  nonce: number,
  openInNewTab = false,
): SqlQueryRequest {
  return {
    profileId,
    database,
    sql,
    execute,
    nonce,
    ...(openInNewTab ? { openInNewTab: true } : {}),
  };
}
