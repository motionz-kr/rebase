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
