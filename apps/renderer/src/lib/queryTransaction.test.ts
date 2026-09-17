import { describe, expect, it } from 'vitest';
import { getTransactionControls, getTransactionStatusLabel } from './queryTransaction';

describe('query transaction controls', () => {
  it('only allows commit for an active manual transaction', () => {
    expect(getTransactionControls('auto', 'active', false)).toEqual({ commit: false, rollback: false });
    expect(getTransactionControls('manual', 'idle', false)).toEqual({ commit: false, rollback: false });
    expect(getTransactionControls('manual', 'active', false)).toEqual({ commit: true, rollback: true });
    expect(getTransactionControls('manual', 'failed', false)).toEqual({ commit: false, rollback: true });
    expect(getTransactionControls('manual', 'active', true)).toEqual({ commit: false, rollback: false });
  });

  it('describes pending changes and uncommitted errors distinctly', () => {
    expect(getTransactionStatusLabel('auto', 'idle')).toBe('Auto-commit');
    expect(getTransactionStatusLabel('manual', 'idle')).toBe('Manual · 대기');
    expect(getTransactionStatusLabel('manual', 'active')).toBe('미커밋 트랜잭션');
    expect(getTransactionStatusLabel('manual', 'failed')).toBe('오류 · 롤백 필요');
  });
});
