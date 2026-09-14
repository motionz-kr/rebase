export interface SqlQueryRequest {
  profileId: string;
  database: string;
  sql: string;
  execute: boolean;
  nonce: number;
}

export function createSqlQueryRequest(
  profileId: string,
  database: string,
  sql: string,
  execute: boolean,
  nonce: number,
): SqlQueryRequest {
  return { profileId, database, sql, execute, nonce };
}
