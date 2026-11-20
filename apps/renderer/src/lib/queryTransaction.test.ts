import { describe, expect, it } from 'vitest';
import {
  LOST_TRANSACTION_ROLLED_BACK_NOTICE,
  getTransactionControls,
  getTransactionStatusLabel,
  hasPendingTransaction,
  resolveRunTransactionState,
  resolveTransactionControlOutcome,
  shouldDiscardSession,
} from './queryTransaction';

describe('query transaction controls', () => {
  it('allows controls for active SQL transactions in either mode', () => {
    expect(getTransactionControls('auto', 'active', false)).toEqual({ commit: true, rollback: true });
    expect(getTransactionControls('auto', 'idle', false)).toEqual({ commit: false, rollback: false });
    expect(getTransactionControls('manual', 'idle', false)).toEqual({ commit: false, rollback: false });
    expect(getTransactionControls('manual', 'active', false)).toEqual({ commit: true, rollback: true });
    expect(getTransactionControls('manual', 'failed', false)).toEqual({ commit: false, rollback: true });
    expect(getTransactionControls('manual', 'active', true)).toEqual({ commit: false, rollback: false });
  });

  it('describes pending changes and uncommitted errors distinctly', () => {
    expect(getTransactionStatusLabel('auto', 'idle')).toBe('Auto-commit');
    expect(getTransactionStatusLabel('auto', 'active')).toBe('미커밋 트랜잭션');
    expect(getTransactionStatusLabel('manual', 'idle')).toBe('Manual · 대기');
    expect(getTransactionStatusLabel('manual', 'active')).toBe('미커밋 트랜잭션');
    expect(getTransactionStatusLabel('manual', 'failed')).toBe('오류 · 롤백 필요');
  });
});

describe('lost query sessions', () => {
  it('enables only Rollback after a connection loss inside a transaction', () => {
    expect(getTransactionControls('manual', 'lost_transaction', false)).toEqual({ commit: false, rollback: true });
    expect(getTransactionControls('auto', 'lost_transaction', false)).toEqual({ commit: false, rollback: true });
    expect(getTransactionControls('manual', 'lost_transaction', true)).toEqual({ commit: false, rollback: false });
    expect(getTransactionControls('manual', 'lost', false)).toEqual({ commit: false, rollback: false });
  });

  it('labels lost states', () => {
    expect(getTransactionStatusLabel('manual', 'lost')).toBe('연결 끊김');
    expect(getTransactionStatusLabel('auto', 'lost')).toBe('연결 끊김');
    expect(getTransactionStatusLabel('manual', 'lost_transaction')).toBe('연결 끊김 · 롤백 필요');
    expect(getTransactionStatusLabel('auto', 'lost_transaction')).toBe('연결 끊김 · 롤백 필요');
  });

  it('treats a lost transaction like a failed one and a lost session as nothing pending', () => {
    for (const state of ['opening', 'active', 'failed', 'lost_transaction'] as const) {
      expect(hasPendingTransaction(state)).toBe(true);
    }
    for (const state of ['idle', 'lost'] as const) {
      expect(hasPendingTransaction(state)).toBe(false);
    }
  });

  it('discards the session only for the lost state', () => {
    expect(shouldDiscardSession('lost')).toBe(true);
    for (const state of ['idle', 'active', 'failed', 'lost_transaction', 'opening', undefined, null]) {
      expect(shouldDiscardSession(state)).toBe(false);
    }
  });

  it('maps the state reported by a run to the tab state', () => {
    expect(resolveRunTransactionState('lost', 'failed')).toBe('idle');
    expect(resolveRunTransactionState('lost_transaction', 'idle')).toBe('lost_transaction');
    expect(resolveRunTransactionState('active', 'idle')).toBe('active');
    expect(resolveRunTransactionState(undefined, 'failed')).toBe('failed');
    expect(resolveRunTransactionState(undefined, 'idle')).toBe('idle');
  });
});

describe('transaction control outcome', () => {
  it('keeps the existing notices for ordinary success', () => {
    expect(resolveTransactionControlOutcome('commit', { success: true, data: { success: true, transactionState: 'idle' } })).toEqual({
      discard: false, transactionState: 'idle', notice: 'Committed', error: null,
    });
    expect(resolveTransactionControlOutcome('rollback', { success: true, data: { success: true } })).toEqual({
      discard: false, transactionState: 'idle', notice: 'Rolled back', error: null,
    });
  });

  it('discards the session and explains it when a rollback finds the connection lost', () => {
    expect(resolveTransactionControlOutcome('rollback', { success: true, data: { success: true, transactionState: 'lost' } })).toEqual({
      discard: true, transactionState: 'idle', notice: LOST_TRANSACTION_ROLLED_BACK_NOTICE, error: null,
    });
    expect(LOST_TRANSACTION_ROLLED_BACK_NOTICE).toBe('연결이 끊겨 트랜잭션이 취소되었습니다');
  });

  it('does not claim a commit succeeded when the session is lost', () => {
    const outcome = resolveTransactionControlOutcome('commit', { success: true, data: { success: true, transactionState: 'lost' } });
    expect(outcome.discard).toBe(true);
    expect(outcome.notice).toBeNull();
  });

  it('keeps the failed state for an ordinary control failure', () => {
    expect(resolveTransactionControlOutcome('commit', { success: false, error: 'deadlock' })).toEqual({
      discard: false, transactionState: 'failed', notice: 'deadlock', error: 'deadlock',
    });
    expect(resolveTransactionControlOutcome('rollback', { success: false })).toEqual({
      discard: false, transactionState: 'failed', notice: '트랜잭션 작업에 실패했습니다.', error: '트랜잭션 작업에 실패했습니다.',
    });
    expect(resolveTransactionControlOutcome('commit', { success: false, error: 'x', transactionState: 'failed' }).transactionState).toBe('failed');
  });

  it('discards the session and keeps the message when a failed commit lost the connection', () => {
    const message = '커밋 중 DB 연결이 끊겨 커밋 여부를 확인할 수 없습니다. 새 연결에서 데이터를 확인한 뒤 진행하세요.';
    expect(resolveTransactionControlOutcome('commit', { success: false, error: message, transactionState: 'lost' })).toEqual({
      discard: true, transactionState: 'idle', notice: message, error: message,
    });
  });

  it('keeps the session and requires Rollback when a failed commit reports lost_transaction', () => {
    const message = '트랜잭션 중 DB 연결이 끊겼습니다. 커밋되지 않은 변경은 서버에서 취소됩니다. Rollback 후 다시 실행하세요.';
    expect(resolveTransactionControlOutcome('commit', { success: false, error: message, transactionState: 'lost_transaction' })).toEqual({
      discard: false, transactionState: 'lost_transaction', notice: message, error: message,
    });
  });
});
