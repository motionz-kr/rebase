import { describe, it, expect } from 'vitest';
import { mapBatchResult } from './runBatch';

const stmts = ['UPDATE t SET a=1 WHERE id=1', 'INSERT INTO t VALUES (2)'];

describe('mapBatchResult', () => {
  it('maps a successful batch', () => {
    expect(mapBatchResult(stmts, { success: true, data: { ok: true, rowsAffected: 2, failedIndex: -1 } })).toEqual({
      ok: true,
      rowsAffected: 2,
    });
  });
  it('maps a failed batch to the failing statement text', () => {
    expect(
      mapBatchResult(stmts, { success: true, data: { ok: false, rowsAffected: 0, failedIndex: 1, error: 'dup key' } })
    ).toEqual({ ok: false, rowsAffected: 0, failedStatement: 'INSERT INTO t VALUES (2)', error: 'dup key' });
  });
  it('handles an out-of-range failedIndex (no failedStatement)', () => {
    expect(mapBatchResult(stmts, { success: true, data: { ok: false, rowsAffected: 0, failedIndex: 9, error: 'x' } })).toEqual({
      ok: false,
      rowsAffected: 0,
      error: 'x',
    });
  });
  it('maps an IPC-level failure (no data)', () => {
    expect(mapBatchResult(stmts, { success: false, error: 'Engine not started' })).toEqual({
      ok: false,
      rowsAffected: 0,
      error: 'Engine not started',
    });
  });
});
