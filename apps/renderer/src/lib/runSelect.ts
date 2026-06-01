// Runs a read-only query and collects its full streamed result into memory.
// Mirrors the renderer's existing stream handling but for one-shot SELECTs
// (e.g. a single page of table data). UI-only adapter.

export interface SelectResult {
  ok: boolean;
  columns: string[];
  rows: unknown[][];
  error?: string;
}

export function runSelect(profileId: string, sql: string): Promise<SelectResult> {
  return new Promise((resolve) => {
    const queryId = `sel-${crypto.randomUUID()}`;
    let settled = false;
    let columns: string[] = [];
    const rows: unknown[][] = [];

    let cleanup: () => void = () => undefined;
    const finish = (r: SelectResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };

    cleanup = window.electronAPI.onQueryStreamChunk((id, chunk: any) => {
      if (id !== queryId || settled) return;
      if (chunk.type === 'meta') {
        columns = chunk.columns ?? [];
      } else if (chunk.type === 'row') {
        rows.push(chunk.data);
      } else if (chunk.type === 'done') {
        finish({ ok: true, columns, rows });
      } else if (chunk.type === 'error') {
        finish({ ok: false, columns, rows, error: chunk.message || 'Query error' });
      } else if (chunk.type === 'policy') {
        finish({ ok: false, columns, rows, error: chunk.message || 'Blocked by policy' });
      }
    });

    window.electronAPI
      .executeQueryStream(queryId, profileId, sql)
      .then((res) => {
        if (!res.success) finish({ ok: false, columns, rows, error: res.error || 'Failed to start query' });
      })
      .catch((e: any) => finish({ ok: false, columns, rows, error: e?.message || 'Request failed' }));
  });
}
