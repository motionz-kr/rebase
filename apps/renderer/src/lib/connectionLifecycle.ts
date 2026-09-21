export type ConnectionTransactionMode = 'auto' | 'manual';
export type ConnectionTransactionState = 'idle' | 'opening' | 'active' | 'failed';

export interface ConnectionTransactionSnapshot {
  transactionMode: ConnectionTransactionMode;
  transactionState: ConnectionTransactionState;
  transactionSessionId: string | null;
}

export interface DisconnectTransactionTab extends ConnectionTransactionSnapshot {
  id: string;
}

export function hasUncommittedTransaction(tab: ConnectionTransactionSnapshot): boolean {
  return tab.transactionMode === 'manual'
    && !!tab.transactionSessionId
    && ['opening', 'active', 'failed'].includes(tab.transactionState);
}

export function getDisconnectTransactionTabs<T extends DisconnectTransactionTab>(tabs: T[]): T[] {
  return tabs.filter(hasUncommittedTransaction);
}
