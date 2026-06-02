export interface HealthResult {
  success: boolean;
  port?: number;
  pid?: number;
  error?: string;
}

export interface ConnectionProfile {
  id?: string;
  name: string;
  driver: 'mysql' | 'postgres' | 'redis';
  host: string;
  port: number;
  database: string;
  username: string;
  secretRef?: string;
  tlsMode: 'none' | 'prefer' | 'require';
  createdAt?: string;
  updatedAt?: string;
}

export interface DatabaseInfo {
  name: string;
}

export interface TableInfo {
  name: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}

export interface TableDescription {
  columns: ColumnInfo[];
}

export interface RedisKeyspaceInfo {
  keys: string[];
  cursor: number;
}

export interface RedisValueInfo {
  type: string;
  value: string;
  ttl: number;
  exists: boolean;
  truncated: boolean;
}

export interface ResultWrapper<T> {
  success: boolean;
  data?: T;
  error?: string;
}

declare global {
  interface Window {
    electronAPI: {
      checkEngineHealth: () => Promise<HealthResult>;
      listProfiles: () => Promise<ResultWrapper<ConnectionProfile[]>>;
      createProfile: (profile: ConnectionProfile, password?: string) => Promise<ResultWrapper<ConnectionProfile>>;
      deleteProfile: (id: string) => Promise<ResultWrapper<{ success: boolean }>>;
      testConnection: (profile: ConnectionProfile, password?: string) => Promise<ResultWrapper<{ success: boolean }>>;
      listDatabases: (profileId: string) => Promise<ResultWrapper<DatabaseInfo[]>>;
      listTables: (profileId: string, database: string) => Promise<ResultWrapper<TableInfo[]>>;
      describeTable: (profileId: string, database: string, table: string) => Promise<ResultWrapper<TableDescription>>;
      getTableDDL: (profileId: string, database: string, table: string) => Promise<ResultWrapper<{ ddl: string }>>;
      getSchemaCompletion: (profileId: string, database: string) => Promise<ResultWrapper<{ tables: { name: string; columns: { name: string; type: string }[] }[] }>>;
      executeQueryStream: (queryId: string, profileId: string, query: string, options?: { allowWrite?: boolean; confirmDestructive?: boolean; maxRows?: number; fetchAll?: boolean }) => Promise<ResultWrapper<{ success: boolean }>>;
      cancelQuery: (queryId: string) => Promise<ResultWrapper<{ success: boolean }>>;
      executeBatch: (
        profileId: string,
        statements: string[]
      ) => Promise<ResultWrapper<{ ok: boolean; rowsAffected: number; failedIndex: number; error?: string }>>;
      onQueryStreamChunk: (callback: (queryId: string, chunk: any) => void) => () => void;
      redisScan: (profileId: string, pattern: string, cursor: number, count: number) => Promise<ResultWrapper<RedisKeyspaceInfo>>;
      redisValue: (profileId: string, key: string) => Promise<ResultWrapper<RedisValueInfo>>;
      listSavedQueries: (workspaceId: string) => Promise<ResultWrapper<any[]>>;
      saveQuery: (savedQuery: any) => Promise<ResultWrapper<any>>;
      deleteSavedQuery: (id: string) => Promise<ResultWrapper<{ success: boolean }>>;
      listQueryHistory: (workspaceId: string, profileId: string) => Promise<ResultWrapper<any[]>>;
      addQueryHistory: (history: any) => Promise<ResultWrapper<any>>;
    };
  }
}
