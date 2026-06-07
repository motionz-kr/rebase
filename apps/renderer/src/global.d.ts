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
  | { kind: 'progress'; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

export interface SchemaGraphColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
}
export interface SchemaGraphTable {
  name: string;
  columns: SchemaGraphColumn[];
}
export interface SchemaGraphFK {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}
export interface SchemaGraph {
  tables: SchemaGraphTable[];
  foreignKeys: SchemaGraphFK[];
}

export interface UserTemplate {
  id: string; workspaceId: string; name: string; description: string;
  category: string; sqlText: string; parameters: string; driver: string;
  createdAt?: string; updatedAt?: string;
}

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
  driver: 'mysql' | 'postgres' | 'redis' | 'sqlite' | 'sqlserver' | 'mongodb';
  host: string;
  port: number;
  database: string;
  username: string;
  connectionUri?: string;
  secretRef?: string;
  tlsMode: 'none' | 'prefer' | 'require';
  readOnly?: boolean;
  safeMode?: boolean;
  tenantColumns?: string;
  domainBindings?: string;
  mcpEnabled?: boolean;
  mcpDataExposure?: string;
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

export interface MongoDocumentResult {
  documents: string[];
  total: number;
}

export interface MongoIndexInfo {
  name: string;
  keys: string;
  unique: boolean;
}

export interface MongoFieldInfo {
  path: string;
  types: string[];
  presence: number;
}

export interface ResultWrapper<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface AnalyzeResult {
  level: 'safe' | 'warn' | 'medium' | 'high';
  verb: string;
  reasons: string[];
  table: string;
  hasWhere: boolean;
  tenantMissing: boolean;
  parseable: boolean;
  affectedRows: number | null;
  previewSql: string;
  previewCols: string[] | null;
  previewRows: unknown[][] | null;
  rollbackSql: string;
  rollbackNote: string;
}

declare global {
  interface Window {
    electronAPI: {
      checkEngineHealth: () => Promise<HealthResult>;
      listProfiles: () => Promise<ResultWrapper<ConnectionProfile[]>>;
      createProfile: (profile: ConnectionProfile, password?: string) => Promise<ResultWrapper<ConnectionProfile>>;
      pickSqliteFile: () => Promise<string | null>;
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
      getSchemaGraph: (profileId: string, database: string) => Promise<ResultWrapper<SchemaGraph>>;
      executeQueryStream: (queryId: string, profileId: string, query: string, options?: { allowWrite?: boolean; confirmDestructive?: boolean; maxRows?: number; fetchAll?: boolean; acknowledged?: boolean }) => Promise<ResultWrapper<{ success: boolean }>>;
      cancelQuery: (queryId: string) => Promise<ResultWrapper<{ success: boolean }>>;
      analyzeQuery: (profileId: string, query: string, database: string) => Promise<ResultWrapper<AnalyzeResult>>;
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
      mcpDetectClients: () => Promise<Array<{ id: string; label: string; present: boolean }>>;
      mcpAutoconnect: (clientId: string, profileId: string) => Promise<ResultWrapper<{ path?: string; backup?: string }>>;
      updateCheck: () => Promise<void>;
      updateDownload: () => Promise<void>;
      updateInstall: () => Promise<void>;
      updateOpenPage: () => Promise<void>;
      updateSimulate: (status: UpdateStatus) => Promise<void>;
      onUpdateStatus: (callback: (status: UpdateStatus) => void) => () => void;
      agentKeyStatus: (provider: string) => Promise<ResultWrapper<{ present: boolean }>>;
      agentKeySet: (provider: string, key: string) => Promise<ResultWrapper<{ ok: boolean }>>;
      agentKeyClear: (provider: string) => Promise<ResultWrapper<{ ok: boolean }>>;
      agentOAuthStart: (provider: string) => Promise<ResultWrapper<{ authorizeUrl: string }>>;
      agentOAuthComplete: (provider: string, code: string) => Promise<ResultWrapper<{ ok: boolean }>>;
      agentOAuthStatus: (provider: string) => Promise<ResultWrapper<{ loggedIn: boolean; expiresAt?: number }>>;
      agentOAuthLogout: (provider: string) => Promise<ResultWrapper<{ ok: boolean }>>;
      onAgentStreamChunk: (callback: (runId: string, chunk: AgentStreamChunk) => void) => () => void;
      redisScan: (profileId: string, pattern: string, cursor: number, count: number) => Promise<ResultWrapper<RedisKeyspaceInfo>>;
      redisValue: (profileId: string, key: string) => Promise<ResultWrapper<RedisValueInfo>>;
      redisSet: (profileId: string, key: string, value: string) => Promise<ResultWrapper<{ ok: boolean }>>;
      redisDelete: (profileId: string, key: string) => Promise<ResultWrapper<{ existed: boolean }>>;
      redisExpire: (profileId: string, key: string, seconds: number) => Promise<ResultWrapper<{ ok: boolean }>>;
      redisRename: (profileId: string, key: string, newKey: string) => Promise<ResultWrapper<{ ok: boolean }>>;
      redisCommand: (profileId: string, args: string[]) => Promise<ResultWrapper<{ output: string; isError: boolean }>>;
      mongoDatabases: (profileId: string) => Promise<ResultWrapper<{ data: { name: string }[] }>>;
      mongoCollections: (profileId: string, database: string) => Promise<ResultWrapper<{ data: { name: string }[] }>>;
      mongoFind: (
        profileId: string,
        database: string,
        collection: string,
        opts?: { filter?: string; projection?: string; sort?: string; skip?: number; limit?: number }
      ) => Promise<ResultWrapper<MongoDocumentResult>>;
      mongoAggregate: (
        profileId: string,
        database: string,
        collection: string,
        pipeline: string,
        limit?: number
      ) => Promise<ResultWrapper<MongoDocumentResult>>;
      mongoCount: (
        profileId: string,
        database: string,
        collection: string,
        filter?: string
      ) => Promise<ResultWrapper<{ count: number }>>;
      mongoInsert: (
        profileId: string,
        database: string,
        collection: string,
        document: string
      ) => Promise<ResultWrapper<{ insertedId: string }>>;
      mongoReplace: (
        profileId: string,
        database: string,
        collection: string,
        id: string,
        document: string
      ) => Promise<ResultWrapper<{ ok: boolean }>>;
      mongoDelete: (
        profileId: string,
        database: string,
        collection: string,
        id: string
      ) => Promise<ResultWrapper<{ ok: boolean }>>;
      mongoIndexes: (
        profileId: string,
        database: string,
        collection: string
      ) => Promise<ResultWrapper<{ data: MongoIndexInfo[] }>>;
      mongoCreateIndex: (
        profileId: string,
        database: string,
        collection: string,
        keys: string,
        unique?: boolean,
        name?: string
      ) => Promise<ResultWrapper<{ ok: boolean }>>;
      mongoDropIndex: (
        profileId: string,
        database: string,
        collection: string,
        name: string
      ) => Promise<ResultWrapper<{ ok: boolean }>>;
      mongoSchema: (
        profileId: string,
        database: string,
        collection: string,
        sampleSize?: number
      ) => Promise<ResultWrapper<{ data: MongoFieldInfo[] }>>;
      listSavedQueries: (workspaceId: string) => Promise<ResultWrapper<SavedQuery[]>>;
      saveQuery: (savedQuery: Record<string, unknown>) => Promise<ResultWrapper<SavedQuery>>;
      deleteSavedQuery: (id: string) => Promise<ResultWrapper<{ success: boolean }>>;
      listTemplates: (workspaceId: string) => Promise<{ success: boolean; data?: UserTemplate[]; error?: string }>;
      saveTemplate: (template: UserTemplate) => Promise<{ success: boolean; data?: UserTemplate; error?: string }>;
      deleteTemplate: (id: string) => Promise<{ success: boolean; error?: string }>;
      listQueryHistory: (workspaceId: string, profileId: string) => Promise<ResultWrapper<QueryHistoryEntry[]>>;
      addQueryHistory: (history: Record<string, unknown>) => Promise<ResultWrapper<QueryHistoryEntry>>;
      getTheme: () => Promise<{ source: 'light' | 'dark' | 'system'; resolved: 'light' | 'dark' }>;
      setThemeSource: (
        source: 'light' | 'dark' | 'system',
      ) => Promise<{ source: 'light' | 'dark' | 'system'; resolved: 'light' | 'dark' }>;
      onThemeUpdated: (
        callback: (payload: { source: 'light' | 'dark' | 'system'; resolved: 'light' | 'dark' }) => void,
      ) => () => void;
    };
    __THEME__?: { source: 'light' | 'dark' | 'system'; resolved: 'light' | 'dark' };
  }
}
