export interface HealthResult {
  success: boolean;
  port?: number;
  pid?: number;
  error?: string;
}

// One chunk of a streamed query result (NDJSON from the engine).
export interface QueryStreamChunk {
  type: 'meta' | 'row' | 'done' | 'error' | 'policy' | string;
  columns?: string[];
  data?: unknown[];
  message?: string;
  rowsAffected?: number;
  truncated?: boolean;
  rowLimit?: number;
  code?: string;
  verb?: string;
}

// One streamed event from an agent turn (mirrors the engine's ports.LLMEvent).
export interface AgentStreamChunk {
  kind: 'text' | 'tool_call' | 'tool_result' | 'done' | 'error';
  text?: string;
  toolCall?: { id: string; name: string; args: Record<string, unknown> };
  toolName?: string;
  toolCallId?: string;
  result?: unknown;
  err?: string;
}

export type UpdateStatus =
  | { kind: 'checking' }
  | { kind: 'available'; version: string; notes?: string }
  | { kind: 'not-available' }
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

export interface SavedQuery {
  id: string;
  workspaceId: string;
  profileId: string;
  name: string;
  queryText: string;
  isFavorite: boolean;
  createdAt: string;
}

export interface QueryHistoryEntry {
  id: string;
  workspaceId: string;
  profileId: string;
  queryText: string;
  executedAt: string;
  durationMs: number;
  success: boolean;
  errorMessage: string | null;
  rowCount: number | null;
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

export interface ForeignKeyInfo {
  column: string;
  refTable: string;
  refColumn: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
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
      updateProfile: (profile: ConnectionProfile, password?: string) => Promise<ResultWrapper<ConnectionProfile>>;
      deleteProfile: (id: string) => Promise<ResultWrapper<{ success: boolean }>>;
      testConnection: (profile: ConnectionProfile, password?: string) => Promise<ResultWrapper<{ success: boolean }>>;
      listDatabases: (profileId: string) => Promise<ResultWrapper<DatabaseInfo[]>>;
      listTables: (profileId: string, database: string) => Promise<ResultWrapper<TableInfo[]>>;
      listForeignKeys: (profileId: string, database: string, table: string) => Promise<ResultWrapper<ForeignKeyInfo[]>>;
      listIndexes: (profileId: string, database: string, table: string) => Promise<ResultWrapper<IndexInfo[]>>;
      describeTable: (profileId: string, database: string, table: string) => Promise<ResultWrapper<TableDescription>>;
      getTableDDL: (profileId: string, database: string, table: string) => Promise<ResultWrapper<{ ddl: string }>>;
      listViews: (profileId: string, database: string) => Promise<ResultWrapper<TableInfo[]>>;
      getViewDDL: (profileId: string, database: string, view: string) => Promise<ResultWrapper<{ ddl: string }>>;
      getSchemaCompletion: (profileId: string, database: string) => Promise<ResultWrapper<{ tables: { name: string; columns: { name: string; type: string }[] }[] }>>;
      executeQueryStream: (queryId: string, profileId: string, query: string, options?: { allowWrite?: boolean; confirmDestructive?: boolean; maxRows?: number; fetchAll?: boolean }) => Promise<ResultWrapper<{ success: boolean }>>;
      cancelQuery: (queryId: string) => Promise<ResultWrapper<{ success: boolean }>>;
      executeBatch: (
        profileId: string,
        statements: string[]
      ) => Promise<ResultWrapper<{ ok: boolean; rowsAffected: number; failedIndex: number; error?: string }>>;
      onQueryStreamChunk: (callback: (queryId: string, chunk: QueryStreamChunk) => void) => () => void;
      agentRun: (
        runId: string,
        profileId: string,
        messages: Array<{ role: string; text: string }>,
        options?: { provider?: string; apiKey?: string; model?: string; dataExposure?: string }
      ) => Promise<ResultWrapper<{ success: boolean }>>;
      agentCancel: (runId: string) => Promise<ResultWrapper<{ success: boolean }>>;
      agentCliStatus: (
        tool: string
      ) => Promise<
        ResultWrapper<{ installed: boolean; loggedIn: boolean; email?: string; subscription?: string; authMethod?: string; detail?: string }>
      >;
      agentCliLogin: (tool: string) => Promise<ResultWrapper<{ success: boolean }>>;
      mcpEnginePath: () => Promise<string>;
      mcpSetSettings: (profileId: string, enabled: boolean, dataExposure: string) => Promise<ResultWrapper<unknown>>;
      updateCheck: () => Promise<void>;
      updateDownload: () => Promise<void>;
      updateInstall: () => Promise<void>;
      updateSimulate: (status: UpdateStatus) => Promise<void>;
      onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void;
      agentKeyStatus: (provider: string) => Promise<ResultWrapper<{ present: boolean }>>;
      agentKeySet: (provider: string, key: string) => Promise<ResultWrapper<{ ok: boolean }>>;
      agentKeyClear: (provider: string) => Promise<ResultWrapper<{ ok: boolean }>>;
      onAgentStreamChunk: (callback: (runId: string, chunk: AgentStreamChunk) => void) => () => void;
      redisScan: (profileId: string, pattern: string, cursor: number, count: number) => Promise<ResultWrapper<RedisKeyspaceInfo>>;
      redisValue: (profileId: string, key: string) => Promise<ResultWrapper<RedisValueInfo>>;
      redisSet: (profileId: string, key: string, value: string) => Promise<ResultWrapper<{ ok: boolean }>>;
      redisDelete: (profileId: string, key: string) => Promise<ResultWrapper<{ existed: boolean }>>;
      redisExpire: (profileId: string, key: string, seconds: number) => Promise<ResultWrapper<{ ok: boolean }>>;
      redisRename: (profileId: string, key: string, newKey: string) => Promise<ResultWrapper<{ ok: boolean }>>;
      redisCommand: (profileId: string, args: string[]) => Promise<ResultWrapper<{ output: string; isError: boolean }>>;
      listSavedQueries: (workspaceId: string) => Promise<ResultWrapper<SavedQuery[]>>;
      saveQuery: (savedQuery: Record<string, unknown>) => Promise<ResultWrapper<SavedQuery>>;
      deleteSavedQuery: (id: string) => Promise<ResultWrapper<{ success: boolean }>>;
      listQueryHistory: (workspaceId: string, profileId: string) => Promise<ResultWrapper<QueryHistoryEntry[]>>;
      addQueryHistory: (history: Record<string, unknown>) => Promise<ResultWrapper<QueryHistoryEntry>>;
    };
  }
}
