// Executes a list of DDL statements sequentially against a connection, using
// the existing query-stream IPC with write + destructive flags enabled. Stops
// at the first failure and reports which statement failed. UI-only adapter.

export interface DdlResult {
  ok: boolean;
  ranCount: number; // how many statements succeeded
  failedStatement?: string;
  error?: string;
}

function runOne(profileId: string, sql: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const queryId = `ddl-${crypto.randomUUID()}`;
    let settled = false;
    // Initialise to a no-op so `finish` can always call cleanup() safely,
    // even if invoked before the onQueryStreamChunk return value is assigned.
    let cleanup: () => void = () => undefined;

    const finish = (result: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    cleanup = window.electronAPI.onQueryStreamChunk((id, chunk) => {
      if (id !== queryId || settled) return;
      if (chunk.type === 'done') {
        finish({ ok: true });
      } else if (chunk.type === 'error') {
        finish({ ok: false, error: chunk.message || 'Execution error' });
      } else if (chunk.type === 'policy') {
        finish({ ok: false, error: chunk.message || 'Blocked by policy' });
      }
    });

    window.electronAPI
      .executeQueryStream(queryId, profileId, sql, { allowWrite: true, confirmDestructive: true })
      .then((res) => {
        if (!res.success) finish({ ok: false, error: res.error || 'Failed to start statement' });
      })
      .catch((e) => {
        finish({ ok: false, error: e instanceof Error ? e.message : 'Request failed' });
      });
  });
}

export async function runDdl(profileId: string, statements: string[]): Promise<DdlResult> {
  let ran = 0;
  for (const sql of statements) {
    const r = await runOne(profileId, sql);
    if (!r.ok) {
      return { ok: false, ranCount: ran, failedStatement: sql, error: r.error };
    }
    ran += 1;
  }
  return { ok: true, ranCount: ran };
}
