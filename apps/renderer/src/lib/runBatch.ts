// Executes a list of statements in a single DB transaction via the engine's
// batch endpoint (all-or-nothing). UI-only adapter + a pure result mapper.

export interface BatchResult {
  ok: boolean;
  rowsAffected: number;
  failedStatement?: string;
  error?: string;
}

interface EngineBatch {
  ok: boolean;
  rowsAffected: number;
  failedIndex: number;
  error?: string;
}

// Map the IPC response (or an IPC-level failure) into a uniform BatchResult.
export function mapBatchResult(
  statements: string[],
  res: { success: boolean; error?: string; data?: EngineBatch }
): BatchResult {
  if (!res.success || !res.data) {
    return { ok: false, rowsAffected: 0, error: res.error || 'Request failed' };
  }
  const d = res.data;
  if (d.ok) return { ok: true, rowsAffected: d.rowsAffected };
  const failedStatement =
    d.failedIndex >= 0 && d.failedIndex < statements.length ? statements[d.failedIndex] : undefined;
  return { ok: false, rowsAffected: d.rowsAffected, failedStatement, error: d.error };
}

export async function runBatch(profileId: string, statements: string[]): Promise<BatchResult> {
  const res = await window.electronAPI.executeBatch(profileId, statements);
  return mapBatchResult(statements, res);
}
