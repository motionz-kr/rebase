export type QueryTransactionMode = 'auto' | 'manual';
export type QueryTransactionState = 'idle' | 'active' | 'failed' | 'opening';

export function getTransactionControls(_mode: QueryTransactionMode, state: QueryTransactionState, loading: boolean) {
  if (loading) return { commit: false, rollback: false };
  return {
    commit: state === 'active',
    rollback: state === 'active' || state === 'failed',
  };
}

export function getTransactionStatusLabel(mode: QueryTransactionMode, state: QueryTransactionState): string {
  if (state === 'active') return '미커밋 트랜잭션';
  if (state === 'failed') return '오류 · 롤백 필요';
  if (state === 'opening') return '세션 연결 중';
  return mode === 'auto' ? 'Auto-commit' : 'Manual · 대기';
}
