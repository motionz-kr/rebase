export type QueryTransactionMode = 'auto' | 'manual';
export type QueryTransactionState = 'idle' | 'active' | 'failed' | 'opening' | 'lost' | 'lost_transaction';

export const LOST_TRANSACTION_ROLLED_BACK_NOTICE = '연결이 끊겨 트랜잭션이 취소되었습니다';

const PENDING_STATES: readonly string[] = ['opening', 'active', 'failed', 'lost_transaction'];

export function getTransactionControls(_mode: QueryTransactionMode, state: QueryTransactionState, loading: boolean) {
  if (loading) return { commit: false, rollback: false };
  return {
    commit: state === 'active',
    rollback: state === 'active' || state === 'failed' || state === 'lost_transaction',
  };
}

export function getTransactionStatusLabel(mode: QueryTransactionMode, state: QueryTransactionState): string {
  if (state === 'active') return '미커밋 트랜잭션';
  if (state === 'failed') return '오류 · 롤백 필요';
  if (state === 'opening') return '세션 연결 중';
  if (state === 'lost') return '연결 끊김';
  if (state === 'lost_transaction') return '연결 끊김 · 롤백 필요';
  return mode === 'auto' ? 'Auto-commit' : 'Manual · 대기';
}

// A pending transaction still has work to resolve (Commit/Rollback) before the
// session can be dropped. A lost connection with nothing in flight ('lost') has
// nothing pending; a lost transaction ('lost_transaction') still needs Rollback.
export function hasPendingTransaction(state: QueryTransactionState): boolean {
  return PENDING_STATES.includes(state);
}

// The engine reports 'lost' when the session's connection is gone and nothing
// is left to resolve; the renderer must drop the session so the next run opens
// a new one.
export function shouldDiscardSession(state: string | null | undefined): boolean {
  return state === 'lost';
}

// State a tab takes after a run reports `reported`. A discarded session leaves
// the tab idle (the curated error stays visible separately).
export function resolveRunTransactionState(
  reported: QueryTransactionState | undefined,
  fallback: QueryTransactionState,
): QueryTransactionState {
  if (shouldDiscardSession(reported)) return 'idle';
  return reported ?? fallback;
}

export interface TransactionControlResult {
  success: boolean;
  data?: { success?: boolean; transactionState?: string };
  error?: string;
  // Present on failed Commit/Rollback calls (engine X-Transaction-State header).
  transactionState?: string;
}

export interface TransactionControlOutcome {
  discard: boolean;
  transactionState: QueryTransactionState;
  notice: string | null;
  error: string | null;
  // The outcome ended the transaction context (success, or the session was
  // discarded as lost): a paused script and its policy prompt must not resume,
  // least of all on a new connection.
  clearContinuation: boolean;
}

export function resolveTransactionControlOutcome(
  action: 'commit' | 'rollback',
  result: TransactionControlResult,
): TransactionControlOutcome {
  if (result.success && result.data?.success !== false) {
    if (shouldDiscardSession(result.data?.transactionState)) {
      return {
        discard: true,
        transactionState: 'idle',
        notice: action === 'rollback' ? LOST_TRANSACTION_ROLLED_BACK_NOTICE : null,
        error: null,
        clearContinuation: true,
      };
    }
    return { discard: false, transactionState: 'idle', notice: action === 'commit' ? 'Committed' : 'Rolled back', error: null, clearContinuation: true };
  }
  const message = result.error || '트랜잭션 작업에 실패했습니다.';
  if (shouldDiscardSession(result.transactionState)) {
    return { discard: true, transactionState: 'idle', notice: message, error: message, clearContinuation: true };
  }
  if (result.transactionState === 'lost_transaction') {
    return { discard: false, transactionState: 'lost_transaction', notice: message, error: message, clearContinuation: false };
  }
  return { discard: false, transactionState: 'failed', notice: message, error: message, clearContinuation: false };
}

// A multi-statement script stops at the first error and when its session was
// discarded as lost; later statements are never sent, and never to a new
// connection (only a new user action opens one).
export function shouldContinueMultiRun(outcome: { error?: string | null; sessionLost?: boolean }): boolean {
  return !outcome.error && !outcome.sessionLost;
}
