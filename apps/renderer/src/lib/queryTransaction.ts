export type QueryTransactionMode = 'auto' | 'manual';
export type QueryTransactionState = 'idle' | 'active' | 'failed' | 'opening';

export function getTransactionControls(mode: QueryTransactionMode, state: QueryTransactionState, loading: boolean) {
  if (mode !== 'manual' || loading) return { commit: false, rollback: false };
  return {
    commit: state === 'active',
    rollback: state === 'active' || state === 'failed',
  };
}

export function getTransactionStatusLabel(mode: QueryTransactionMode, state: QueryTransactionState): string {
  if (mode === 'auto') return 'Auto-commit';
  if (state === 'active') return '미커밋 트랜잭션';
  if (state === 'failed') return '오류 · 롤백 필요';
  if (state === 'opening') return '세션 연결 중';
  return 'Manual · 대기';
}
