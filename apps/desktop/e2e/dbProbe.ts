import * as net from 'net';

// Returns true if a TCP connection to host:port succeeds within the timeout.
// Used to skip DB-dependent E2E flows gracefully when no local MySQL is running.
export function isPortOpen(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

// Local MySQL connection used by the flow tests — mirrors the engine's Go
// integration tests (127.0.0.1:3306, devdb, root). Password overridable via env.
export const MYSQL = {
  host: '127.0.0.1',
  port: 3306,
  database: 'devdb',
  username: 'root',
  password: process.env.E2E_MYSQL_PASSWORD ?? 'password1!',
};

// Local Redis used by the Redis E2E (127.0.0.1:6379). The test only ever
// touches keys under the `rebase:e2e:` prefix so it is safe against any real
// data on the same instance.
export const REDIS = {
  host: '127.0.0.1',
  port: Number(process.env.E2E_REDIS_PORT ?? 6379),
};
