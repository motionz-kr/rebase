import mysql from 'mysql2/promise';
import { MYSQL } from './dbProbe';

// Direct MySQL access for seeding/verifying E2E fixtures, independent of the app.
// Used only against throwaway tables created and dropped by the tests.
export async function withConn<T>(fn: (c: mysql.Connection) => Promise<T>): Promise<T> {
  const c = await mysql.createConnection({
    host: MYSQL.host,
    port: MYSQL.port,
    user: MYSQL.username,
    password: MYSQL.password,
    database: MYSQL.database,
  });
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
