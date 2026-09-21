import { describe, expect, it } from 'vitest';
import { getDisconnectTransactionTabs, hasUncommittedTransaction } from './connectionLifecycle';

describe('connection lifecycle', () => {
  it('recognizes a manual transaction that must be resolved before disconnect', () => {
    expect(hasUncommittedTransaction({
      transactionMode: 'manual',
      transactionState: 'active',
      transactionSessionId: 'session-1',
    })).toBe(true);
  });

  it('does not block disconnect for auto-commit or an idle manual tab', () => {
    expect(hasUncommittedTransaction({
      transactionMode: 'auto',
      transactionState: 'idle',
      transactionSessionId: null,
    })).toBe(false);
    expect(hasUncommittedTransaction({
      transactionMode: 'manual',
      transactionState: 'idle',
      transactionSessionId: 'session-2',
    })).toBe(false);
  });

  it('returns every manual tab with an unresolved transaction', () => {
    expect(getDisconnectTransactionTabs([
      { id: 'tab-1', transactionMode: 'manual', transactionState: 'active', transactionSessionId: 'a' },
      { id: 'tab-2', transactionMode: 'manual', transactionState: 'idle', transactionSessionId: 'b' },
      { id: 'tab-3', transactionMode: 'manual', transactionState: 'failed', transactionSessionId: 'c' },
    ]).map((tab) => tab.id)).toEqual(['tab-1', 'tab-3']);
  });
});
