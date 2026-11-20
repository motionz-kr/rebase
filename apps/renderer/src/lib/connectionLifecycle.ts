import { hasPendingTransaction, type QueryTransactionState } from './queryTransaction';

export type ConnectionTransactionMode = 'auto' | 'manual';
export type ConnectionTransactionState = QueryTransactionState;

export interface ConnectionTransactionSnapshot {
  transactionMode: ConnectionTransactionMode;
  transactionState: ConnectionTransactionState;
  transactionSessionId: string | null;
}

export interface DisconnectTransactionTab extends ConnectionTransactionSnapshot {
  id: string;
}

export function hasUncommittedTransaction(tab: ConnectionTransactionSnapshot): boolean {
  return !!tab.transactionSessionId && hasPendingTransaction(tab.transactionState);
}

export function getDisconnectTransactionTabs<T extends DisconnectTransactionTab>(tabs: T[]): T[] {
  return tabs.filter(hasUncommittedTransaction);
}
