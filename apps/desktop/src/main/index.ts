import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as http from 'http';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { EngineManager } from './engine_manager';
import isDev from 'electron-is-dev';

let mainWindow: BrowserWindow | null = null;
let engineManager: EngineManager | null = null;
let launchToken: string = '';

// In-flight query stream requests, keyed by queryId, so they can be aborted on
// explicit cancel or when the window closes (otherwise the socket leaks until
// the engine finishes the query).
const activeStreams = new Map<string, http.ClientRequest>();

function abortStream(queryId: string): void {
  const req = activeStreams.get(queryId);
  if (req) {
    req.destroy();
    activeStreams.delete(queryId);
  }
}

function abortAllStreams(): void {
  for (const req of activeStreams.values()) {
    req.destroy();
  }
  activeStreams.clear();
}

// Synchronously kill the engine if the main process is torn down abruptly
// (crash, SIGINT/SIGTERM). will-quit does not fire in those cases, so without
// this the Go engine can survive as an orphan holding DB connections.
let cleanedUp = false;
function killEngineSync(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  abortAllStreams();
  engineManager?.killSync();
}
process.on('exit', killEngineSync);
process.on('SIGINT', () => {
  killEngineSync();
  process.exit(0);
});
process.on('SIGTERM', () => {
  killEngineSync();
  process.exit(0);
});

const handshakePath = path.join(app.getPath('temp'), `db-handshake-${crypto.randomUUID()}.json`);
const binaryPath = isDev 
  ? path.join(__dirname, '..', '..', 'bin', 'app-engine')
  : path.join(process.resourcesPath, 'bin', 'app-engine');

async function checkGoEngineHealth(port: number, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        headers: {
          'X-App-Engine-Token': token,
        },
        timeout: 1000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve(data.ready === true);
          } catch (e) {
            resolve(false);
          }
        });
      }
    );

    req.on('error', () => {
      resolve(false);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.end();
  });
}

async function startEngineAndApp() {
  launchToken = crypto.randomBytes(32).toString('hex');
  engineManager = new EngineManager({
    binaryPath,
    handshakePath,
    token: launchToken,
  });

  console.log('Starting Go engine at:', binaryPath);
  const started = await engineManager.start();
  if (!started) {
    console.error('Go engine failed to start.');
  } else {
    console.log(`Go engine started on port ${engineManager.getPort()} (PID: ${engineManager.getPid()})`);
  }

  createWindow();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (isDev) {
    // In dev, clear the cache so edited CSS/JS is never served stale.
    mainWindow.webContents.session.clearCache().finally(() => {
      mainWindow?.loadURL('http://localhost:5173');
    });
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', '..', 'renderer', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    // Tear down any in-flight query streams; their 'line' handlers would
    // otherwise keep firing against a destroyed window and the sockets leak.
    abortAllStreams();
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  ipcMain.handle('check-engine-health', async () => {
    if (!engineManager || engineManager.getPort() === null) {
      return { success: false, error: 'Engine not started' };
    }
    const healthy = await checkGoEngineHealth(engineManager.getPort()!, launchToken);
    return {
      success: healthy,
      port: engineManager.getPort(),
      pid: engineManager.getPid(),
    };
  });

  async function requestEngine(options: {
    method: 'GET' | 'POST' | 'DELETE' | 'PUT';
    path: string;
    body?: any;
  }): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!engineManager || engineManager.getPort() === null) {
        return reject(new Error('Engine not started'));
      }

      const port = engineManager.getPort()!;
      const headers: Record<string, string> = {
        'X-App-Engine-Token': launchToken,
      };

      let postData: string | undefined;
      if (options.body) {
        postData = JSON.stringify(options.body);
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(postData).toString();
      }

      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: options.path,
          method: options.method,
          headers,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(body || `Request failed with status ${res.statusCode}`));
              return;
            }
            try {
              if (body) {
                resolve(JSON.parse(body));
              } else {
                resolve({ success: true });
              }
            } catch (e) {
              resolve(body);
            }
          });
        }
      );

      req.on('error', (err) => {
        reject(err);
      });

      if (postData) {
        req.write(postData);
      }
      req.end();
    });
  }

  ipcMain.handle('list-profiles', async () => {
    try {
      const data = await requestEngine({ method: 'GET', path: '/profiles' });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('create-profile', async (event, profile, password) => {
    try {
      const data = await requestEngine({
        method: 'POST',
        path: '/profiles',
        body: { profile, password },
      });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('update-profile', async (event, profile, password) => {
    try {
      const data = await requestEngine({ method: 'PUT', path: '/profiles', body: { profile, password } });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('delete-profile', async (event, id) => {
    try {
      const data = await requestEngine({
        method: 'DELETE',
        path: `/profiles?id=${encodeURIComponent(id)}`,
      });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('test-connection', async (event, profile, password) => {
    try {
      const data = await requestEngine({
        method: 'POST',
        path: '/connection-test',
        body: { profile, password },
      });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('list-databases', async (event, profileId) => {
    try {
      const data = await requestEngine({
        method: 'GET',
        path: `/databases?profileId=${encodeURIComponent(profileId)}`,
      });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('list-tables', async (event, profileId, database) => {
    try {
      const data = await requestEngine({
        method: 'GET',
        path: `/tables?profileId=${encodeURIComponent(profileId)}&database=${encodeURIComponent(database)}`,
      });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('describe-table', async (event, profileId, database, table) => {
    try {
      const data = await requestEngine({
        method: 'GET',
        path: `/describe-table?profileId=${encodeURIComponent(profileId)}&database=${encodeURIComponent(database)}&table=${encodeURIComponent(table)}`,
      });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-table-ddl', async (event, profileId, database, table) => {
    try {
      const data = await requestEngine({
        method: 'GET',
        path: `/table-ddl?profileId=${encodeURIComponent(profileId)}&database=${encodeURIComponent(database)}&table=${encodeURIComponent(table)}`,
      });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('list-foreign-keys', async (event, profileId, database, table) => {
    try {
      const data = await requestEngine({ method: 'GET', path: `/foreign-keys?profileId=${encodeURIComponent(profileId)}&database=${encodeURIComponent(database)}&table=${encodeURIComponent(table)}` });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('list-views', async (event, profileId, database) => {
    try {
      const data = await requestEngine({ method: 'GET', path: `/views?profileId=${encodeURIComponent(profileId)}&database=${encodeURIComponent(database)}` });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
  ipcMain.handle('get-view-ddl', async (event, profileId, database, view) => {
    try {
      const data = await requestEngine({ method: 'GET', path: `/view-ddl?profileId=${encodeURIComponent(profileId)}&database=${encodeURIComponent(database)}&view=${encodeURIComponent(view)}` });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-schema-completion', async (event, profileId, database) => {
    try {
      const data = await requestEngine({
        method: 'GET',
        path: `/schema-completion?profileId=${encodeURIComponent(profileId)}&database=${encodeURIComponent(database)}`,
      });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('execute-query-stream', async (event, queryId, profileId, query, options) => {
    try {
      if (!engineManager || engineManager.getPort() === null) {
        throw new Error('Engine not started');
      }

      const port = engineManager.getPort()!;
      const postData = JSON.stringify({
        profileId,
        query,
        queryId,
        allowWrite: options?.allowWrite ?? false,
        confirmDestructive: options?.confirmDestructive ?? false,
        maxRows: options?.maxRows ?? 0,
        fetchAll: options?.fetchAll ?? false,
      });

      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/query/execute',
          method: 'POST',
          headers: {
            'X-App-Engine-Token': launchToken,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData).toString(),
          },
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 400) {
            let errBody = '';
            res.on('data', (c) => (errBody += c));
            res.on('end', () => {
              activeStreams.delete(queryId);
              if (!mainWindow) return;
              // The policy gate returns a structured JSON error (403 read-only,
              // 409 destructive-confirm) before any stream. Forward it as a
              // 'policy' chunk so the renderer can prompt instead of just failing.
              const status = res.statusCode!;
              if (status === 403 || status === 409) {
                try {
                  const parsed = JSON.parse(errBody);
                  if (parsed && parsed.code) {
                    mainWindow.webContents.send('query-stream-chunk', queryId, {
                      type: 'policy',
                      code: parsed.code,
                      message: parsed.error,
                      verb: parsed.verb,
                    });
                    return;
                  }
                } catch {
                  // fall through to generic error
                }
              }
              mainWindow.webContents.send('query-stream-chunk', queryId, {
                type: 'error',
                message: errBody || `Request failed with status ${res.statusCode}`,
              });
            });
            return;
          }

          const rl = readline.createInterface({
            input: res,
            terminal: false,
          });

          rl.on('line', (line) => {
            if (!line.trim()) return;
            try {
              const data = JSON.parse(line);
              if (mainWindow) {
                mainWindow.webContents.send('query-stream-chunk', queryId, data);
              }
            } catch (e) {
              console.error('Failed to parse NDJSON line:', e);
            }
          });

          // Stop tracking once the response is fully consumed or torn down.
          res.on('close', () => {
            rl.close();
            activeStreams.delete(queryId);
          });
        }
      );

      req.on('error', (err) => {
        activeStreams.delete(queryId);
        // 'aborted'/ECONNRESET from an intentional destroy() (cancel or window
        // close) is expected; don't surface it as a query error.
        if (mainWindow && !req.destroyed) {
          mainWindow.webContents.send('query-stream-chunk', queryId, {
            type: 'error',
            message: err.message,
          });
        }
      });

      activeStreams.set(queryId, req);
      req.write(postData);
      req.end();

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('execute-batch', async (event, profileId, statements) => {
    try {
      const data = await requestEngine({
        method: 'POST',
        path: '/query/execute-batch',
        body: { profileId, statements, allowWrite: true, confirmDestructive: true },
      });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('cancel-query', async (event, queryId) => {
    try {
      // Tell the engine to cancel server-side, then tear down the local stream
      // socket so we stop receiving rows even if the engine is slow to stop.
      const data = await requestEngine({
        method: 'POST',
        path: '/query/cancel',
        body: { queryId },
      });
      abortStream(queryId);
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('redis-scan', async (event, profileId, pattern, cursor, count) => {
    try {
      const data = await requestEngine({
        method: 'GET',
        path: `/redis/scan?profileId=${encodeURIComponent(profileId)}&pattern=${encodeURIComponent(pattern)}&cursor=${cursor}&count=${count}`,
      });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('redis-value', async (event, profileId, key) => {
    try {
      const data = await requestEngine({
        method: 'GET',
        path: `/redis/value?profileId=${encodeURIComponent(profileId)}&key=${encodeURIComponent(key)}`,
      });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('list-saved-queries', async (event, workspaceId) => {
    try {
      const data = await requestEngine({
        method: 'GET',
        path: `/saved-queries?workspaceId=${encodeURIComponent(workspaceId)}`,
      });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('save-query', async (event, savedQuery) => {
    try {
      const data = await requestEngine({
        method: 'POST',
        path: '/saved-queries',
        body: savedQuery,
      });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('delete-saved-query', async (event, id) => {
    try {
      const data = await requestEngine({
        method: 'DELETE',
        path: `/saved-queries?id=${encodeURIComponent(id)}`,
      });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('list-query-history', async (event, workspaceId, profileId) => {
    try {
      const data = await requestEngine({
        method: 'GET',
        path: `/query-history?workspaceId=${encodeURIComponent(workspaceId)}&profileId=${encodeURIComponent(profileId)}`,
      });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('add-query-history', async (event, history) => {
    try {
      const data = await requestEngine({
        method: 'POST',
        path: '/query-history',
        body: history,
      });
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  startEngineAndApp();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('will-quit', async () => {
  if (engineManager) {
    console.log('Stopping Go engine...');
    await engineManager.stop();
  }
});
