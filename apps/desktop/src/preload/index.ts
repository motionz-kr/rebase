import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  checkEngineHealth: () => ipcRenderer.invoke('check-engine-health'),
  listProfiles: () => ipcRenderer.invoke('list-profiles'),
  createProfile: (profile: any, password?: string) => ipcRenderer.invoke('create-profile', profile, password),
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
  executeQueryStream: (
    queryId: string,
    profileId: string,
    query: string,
    options?: { allowWrite?: boolean; confirmDestructive?: boolean; maxRows?: number; fetchAll?: boolean }
  ) => ipcRenderer.invoke('execute-query-stream', queryId, profileId, query, options),
  cancelQuery: (queryId: string) => ipcRenderer.invoke('cancel-query', queryId),
  agentRun: (
    runId: string,
    profileId: string,
    messages: Array<{ role: string; text: string }>,
    options?: { provider?: string; apiKey?: string; model?: string; dataExposure?: string }
  ) => ipcRenderer.invoke('agent-run', runId, profileId, messages, options),
  agentCancel: (runId: string) => ipcRenderer.invoke('agent-cancel', runId),
  agentCliStatus: (tool: string) => ipcRenderer.invoke('agent-cli-status', tool),
  agentCliLogin: (tool: string) => ipcRenderer.invoke('agent-cli-login', tool),
  mcpEnginePath: () => ipcRenderer.invoke('mcp-engine-path'),
  mcpSetSettings: (profileId: string, enabled: boolean, dataExposure: string) =>
    ipcRenderer.invoke('mcp-set-settings', profileId, enabled, dataExposure),
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateDownload: () => ipcRenderer.invoke('update-download'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  updateSimulate: (status: any) => ipcRenderer.invoke('update-simulate', status),
  onUpdateStatus: (callback: (status: any) => void) => {
    const listener = (_event: any, status: any) => callback(status);
    ipcRenderer.on('update-status', listener);
    return () => {
      ipcRenderer.removeListener('update-status', listener);
    };
  },
  agentKeyStatus: (provider: string) => ipcRenderer.invoke('agent-key-status', provider),
  agentKeySet: (provider: string, key: string) => ipcRenderer.invoke('agent-key-set', provider, key),
  agentKeyClear: (provider: string) => ipcRenderer.invoke('agent-key-clear', provider),
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
  listSavedQueries: (workspaceId: string) => ipcRenderer.invoke('list-saved-queries', workspaceId),
  saveQuery: (savedQuery: any) => ipcRenderer.invoke('save-query', savedQuery),
  deleteSavedQuery: (id: string) => ipcRenderer.invoke('delete-saved-query', id),
  listQueryHistory: (workspaceId: string, profileId: string) => ipcRenderer.invoke('list-query-history', workspaceId, profileId),
  addQueryHistory: (history: any) => ipcRenderer.invoke('add-query-history', history),
});
