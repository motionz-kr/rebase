import { contextBridge, ipcRenderer } from 'electron';

function readThemeArg(key: string): string | undefined {
  const prefix = `--${key}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

const injectedSource = readThemeArg('theme-source');
contextBridge.exposeInMainWorld('__THEME__', {
  source:
    injectedSource === 'light' || injectedSource === 'dark' || injectedSource === 'system'
      ? injectedSource
      : 'dark',
  resolved: readThemeArg('theme') === 'light' ? 'light' : 'dark',
});

contextBridge.exposeInMainWorld('electronAPI', {
  checkEngineHealth: () => ipcRenderer.invoke('check-engine-health'),
  listProfiles: () => ipcRenderer.invoke('list-profiles'),
  createProfile: (profile: any, password?: string) => ipcRenderer.invoke('create-profile', profile, password),
  pickSqliteFile: () => ipcRenderer.invoke('pick-sqlite-file'),
  updateProfile: (profile: any, password?: string) => ipcRenderer.invoke('update-profile', profile, password),
  deleteProfile: (id: string) => ipcRenderer.invoke('delete-profile', id),
  testConnection: (profile: any, password?: string) => ipcRenderer.invoke('test-connection', profile, password),
  listDatabases: (profileId: string) => ipcRenderer.invoke('list-databases', profileId),
  listTables: (profileId: string, database: string) => ipcRenderer.invoke('list-tables', profileId, database),
  describeTable: (profileId: string, database: string, table: string) => ipcRenderer.invoke('describe-table', profileId, database, table),
  getTableDDL: (profileId: string, database: string, table: string) => ipcRenderer.invoke('get-table-ddl', profileId, database, table),
  listForeignKeys: (profileId: string, database: string, table: string) => ipcRenderer.invoke('list-foreign-keys', profileId, database, table),
  listIndexes: (profileId: string, database: string, table: string) => ipcRenderer.invoke('list-indexes', profileId, database, table),
  listViews: (profileId: string, database: string) => ipcRenderer.invoke('list-views', profileId, database),
  getViewDDL: (profileId: string, database: string, view: string) => ipcRenderer.invoke('get-view-ddl', profileId, database, view),
  getSchemaCompletion: (profileId: string, database: string) => ipcRenderer.invoke('get-schema-completion', profileId, database),
  getSchemaGraph: (profileId: string, database: string) => ipcRenderer.invoke('get-schema-graph', profileId, database),
  executeQueryStream: (
    queryId: string,
    profileId: string,
    query: string,
    options?: { allowWrite?: boolean; confirmDestructive?: boolean; maxRows?: number; fetchAll?: boolean; acknowledged?: boolean }
  ) => ipcRenderer.invoke('execute-query-stream', queryId, profileId, query, options),
  cancelQuery: (queryId: string) => ipcRenderer.invoke('cancel-query', queryId),
  analyzeQuery: (profileId: string, query: string, database: string) =>
    ipcRenderer.invoke('analyze-query', profileId, query, database),
  agentRun: (
    runId: string,
    profileId: string,
    messages: Array<{ role: string; text: string }>,
    options?: { provider?: string; apiKey?: string; model?: string; dataExposure?: string }
  ) => ipcRenderer.invoke('agent-run', runId, profileId, messages, options),
  generateNarration: (
    runId: string,
    profileId: string,
    system: string,
    messages: Array<{ role: string; text: string }>,
    options?: { provider?: string; apiKey?: string; model?: string }
  ) => ipcRenderer.invoke('generate-narration', runId, profileId, system, messages, options),
  agentCancel: (runId: string) => ipcRenderer.invoke('agent-cancel', runId),
  agentCliStatus: (tool: string) => ipcRenderer.invoke('agent-cli-status', tool),
  agentCliLogin: (tool: string) => ipcRenderer.invoke('agent-cli-login', tool),
  mcpEnginePath: () => ipcRenderer.invoke('mcp-engine-path'),
  mcpSetSettings: (profileId: string, enabled: boolean, dataExposure: string) =>
    ipcRenderer.invoke('mcp-set-settings', profileId, enabled, dataExposure),
  mcpDetectClients: () => ipcRenderer.invoke('mcp-detect-clients'),
  mcpAutoconnect: (clientId: string, profileId: string) => ipcRenderer.invoke('mcp-autoconnect', clientId, profileId),
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateDownload: () => ipcRenderer.invoke('update-download'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  updateOpenPage: () => ipcRenderer.invoke('update-open-page'),
  updateSimulate: (status: any) => ipcRenderer.invoke('update-simulate', status),
  onUpdateStatus: (callback: (status: any) => void) => {
    const listener = (_event: any, status: any) => callback(status);
    ipcRenderer.on('update-status', listener);
    return () => {
      ipcRenderer.removeListener('update-status', listener);
    };
  },
  getTheme: () => ipcRenderer.invoke('theme-get'),
  setThemeSource: (source: string) => ipcRenderer.invoke('theme-set-source', source),
  onThemeUpdated: (
    callback: (payload: { source: string; resolved: string }) => void,
  ) => {
    const listener = (_event: any, payload: any) => callback(payload);
    ipcRenderer.on('theme-updated', listener);
    return () => {
      ipcRenderer.removeListener('theme-updated', listener);
    };
  },
  agentKeyStatus: (provider: string) => ipcRenderer.invoke('agent-key-status', provider),
  agentKeySet: (provider: string, key: string) => ipcRenderer.invoke('agent-key-set', provider, key),
  agentKeyClear: (provider: string) => ipcRenderer.invoke('agent-key-clear', provider),
  agentOAuthStart: (provider: string) => ipcRenderer.invoke('agent-oauth-start', provider),
  agentOAuthComplete: (provider: string, code: string) => ipcRenderer.invoke('agent-oauth-complete', provider, code),
  agentOAuthStatus: (provider: string) => ipcRenderer.invoke('agent-oauth-status', provider),
  agentOAuthLogout: (provider: string) => ipcRenderer.invoke('agent-oauth-logout', provider),
  onAgentStreamChunk: (callback: (runId: string, chunk: any) => void) => {
    const listener = (_event: any, rId: string, chunk: any) => callback(rId, chunk);
    ipcRenderer.on('agent-stream-chunk', listener);
    return () => {
      ipcRenderer.removeListener('agent-stream-chunk', listener);
    };
  },
  executeBatch: (profileId: string, statements: string[]) =>
    ipcRenderer.invoke('execute-batch', profileId, statements),
  onQueryStreamChunk: (callback: (queryId: string, chunk: any) => void) => {
    const listener = (_event: any, qId: string, chunk: any) => callback(qId, chunk);
    ipcRenderer.on('query-stream-chunk', listener);
    return () => {
      ipcRenderer.removeListener('query-stream-chunk', listener);
    };
  },
  redisScan: (profileId: string, pattern: string, cursor: number, count: number) => ipcRenderer.invoke('redis-scan', profileId, pattern, cursor, count),
  redisValue: (profileId: string, key: string) => ipcRenderer.invoke('redis-value', profileId, key),
  redisSet: (profileId: string, key: string, value: string) => ipcRenderer.invoke('redis-set', profileId, key, value),
  redisDelete: (profileId: string, key: string) => ipcRenderer.invoke('redis-delete', profileId, key),
  redisExpire: (profileId: string, key: string, seconds: number) => ipcRenderer.invoke('redis-expire', profileId, key, seconds),
  redisRename: (profileId: string, key: string, newKey: string) => ipcRenderer.invoke('redis-rename', profileId, key, newKey),
  redisCommand: (profileId: string, args: string[]) => ipcRenderer.invoke('redis-command', profileId, args),
  mongoDatabases: (profileId: string) => ipcRenderer.invoke('mongo-databases', profileId),
  mongoCollections: (profileId: string, database: string) => ipcRenderer.invoke('mongo-collections', profileId, database),
  mongoFind: (
    profileId: string,
    database: string,
    collection: string,
    opts?: { filter?: string; projection?: string; sort?: string; skip?: number; limit?: number },
  ) => ipcRenderer.invoke('mongo-find', profileId, database, collection, opts),
  mongoAggregate: (profileId: string, database: string, collection: string, pipeline: string, limit?: number) =>
    ipcRenderer.invoke('mongo-aggregate', profileId, database, collection, pipeline, limit),
  mongoCount: (profileId: string, database: string, collection: string, filter?: string) =>
    ipcRenderer.invoke('mongo-count', profileId, database, collection, filter),
  mongoInsert: (profileId: string, database: string, collection: string, document: string) =>
    ipcRenderer.invoke('mongo-insert', profileId, database, collection, document),
  mongoReplace: (profileId: string, database: string, collection: string, id: string, document: string) =>
    ipcRenderer.invoke('mongo-replace', profileId, database, collection, id, document),
  mongoDelete: (profileId: string, database: string, collection: string, id: string) =>
    ipcRenderer.invoke('mongo-delete', profileId, database, collection, id),
  mongoIndexes: (profileId: string, database: string, collection: string) =>
    ipcRenderer.invoke('mongo-indexes', profileId, database, collection),
  mongoCreateIndex: (
    profileId: string,
    database: string,
    collection: string,
    keys: string,
    unique?: boolean,
    name?: string,
  ) => ipcRenderer.invoke('mongo-create-index', profileId, database, collection, keys, unique, name),
  mongoDropIndex: (profileId: string, database: string, collection: string, name: string) =>
    ipcRenderer.invoke('mongo-drop-index', profileId, database, collection, name),
  mongoSchema: (profileId: string, database: string, collection: string, sampleSize?: number) =>
    ipcRenderer.invoke('mongo-schema', profileId, database, collection, sampleSize),
  listSavedQueries: (workspaceId: string) => ipcRenderer.invoke('list-saved-queries', workspaceId),
  saveQuery: (savedQuery: any) => ipcRenderer.invoke('save-query', savedQuery),
  deleteSavedQuery: (id: string) => ipcRenderer.invoke('delete-saved-query', id),
  listTemplates: (workspaceId: string) => ipcRenderer.invoke('list-templates', workspaceId),
  saveTemplate: (template: any) => ipcRenderer.invoke('save-template', template),
  deleteTemplate: (id: string) => ipcRenderer.invoke('delete-template', id),
  listQueryHistory: (workspaceId: string, profileId: string) => ipcRenderer.invoke('list-query-history', workspaceId, profileId),
  addQueryHistory: (history: any) => ipcRenderer.invoke('add-query-history', history),
});
