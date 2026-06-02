import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';

export interface EngineConfig {
  binaryPath: string;
  handshakePath: string;
  token: string;
  // Optional override for the engine's SQLite metadata path (-db). Used by tests
  // to isolate the profile store; production leaves it unset (engine default).
  dbPath?: string;
}

export class EngineManager {
  private config: EngineConfig;
  private process: ChildProcess | null = null;
  private port: number | null = null;
  private pid: number | null = null;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  async start(): Promise<boolean> {
    const args = ['-token', this.config.token, '-handshake', this.config.handshakePath];
    if (this.config.dbPath) args.push('-db', this.config.dbPath);
    this.process = spawn(this.config.binaryPath, args);

    this.process.on('error', (err) => {
      console.error('Failed to start Go engine process:', err);
    });

    // Detect a crashed/exited engine so callers don't keep talking to a dead
    // port. Clearing state here means getPort()/getPid() return null after exit.
    this.process.on('exit', (code, signal) => {
      console.error(`Go engine exited (code=${code}, signal=${signal})`);
      this.process = null;
      this.pid = null;
      this.port = null;
    });

    const maxRetries = 100;
    for (let i = 0; i < maxRetries; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (fs.existsSync(this.config.handshakePath)) {
        try {
          const raw = fs.readFileSync(this.config.handshakePath, 'utf8');
          if (raw.trim()) {
            const data = JSON.parse(raw);
            if (data.ready && data.port && data.pid) {
              this.port = data.port;
              this.pid = data.pid;
              return true;
            }
          }
        } catch (e) {
          // File might be in the middle of being written, ignore and try again
        }
      }
    }

    console.error('Go engine startup timed out or failed to write handshake file');
    return false;
  }

  async stop(): Promise<void> {
    const proc = this.process;
    this.process = null;
    this.pid = null;
    this.port = null;

    if (proc && proc.exitCode === null && !proc.killed) {
      await new Promise<void>((resolve) => {
        // Escalate to SIGKILL if the engine doesn't exit promptly on SIGTERM,
        // so it can't survive as an orphan holding DB connections.
        const timer = setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            // already gone
          }
          resolve();
        }, 3000);
        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        proc.kill('SIGTERM');
      });
    }

    if (fs.existsSync(this.config.handshakePath)) {
      try {
        fs.unlinkSync(this.config.handshakePath);
      } catch (e) {
        // Ignore
      }
    }
  }

  /**
   * Best-effort synchronous kill for use in process-exit handlers, where async
   * cleanup (stop()) cannot run. Prevents an orphaned engine if the main
   * process is terminated abruptly.
   */
  killSync(): void {
    const proc = this.process;
    if (proc && proc.exitCode === null && !proc.killed) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }

  getPort(): number | null {
    return this.port;
  }

  getPid(): number | null {
    return this.pid;
  }
}
