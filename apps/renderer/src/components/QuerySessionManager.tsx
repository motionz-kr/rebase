import React from 'react';
import { Check, Database, Lock, Pencil, RotateCcw, Square, X } from 'lucide-react';
import { getTransactionControls, getTransactionStatusLabel, type QueryTransactionMode, type QueryTransactionState } from '../lib/queryTransaction';

export interface QuerySessionClient {
  id: string;
  name: string;
  database: string;
  writeMode: boolean;
  transactionMode: QueryTransactionMode;
  transactionState: QueryTransactionState;
  transactionSessionId: string | null;
  transactionNotice: string | null;
  loading: boolean;
  queryId: string | null;
}

interface Props {
  open: boolean;
  connectionName: string;
  clients: QuerySessionClient[];
  activeTabId: string;
  onClose: () => void;
  onSelectTab: (tabId: string) => void;
  onCommit: (tabId: string) => void;
  onRollback: (tabId: string) => void;
  onCloseSession: (tabId: string) => void;
  onCancelQuery: (tabId: string, queryId: string) => void;
}

const shortSessionId = (sessionId: string): string => (
  sessionId.length > 14 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}` : sessionId
);

export const QuerySessionManager: React.FC<Props> = ({
  open,
  connectionName,
  clients,
  activeTabId,
  onClose,
  onSelectTab,
  onCommit,
  onRollback,
  onCloseSession,
  onCancelQuery,
}) => {
  if (!open) return null;

  return (
    <div className="session-manager-backdrop" role="dialog" aria-modal="true" aria-labelledby="session-manager-title" onClick={onClose}>
      <div className="session-manager" onClick={(event) => event.stopPropagation()}>
        <header className="session-manager-header">
          <div>
            <h3 id="session-manager-title">세션 관리</h3>
            <p>{connectionName} · {clients.length}개 쿼리탭(client)</p>
          </div>
          <button className="icon-btn" aria-label="세션 관리 닫기" onClick={onClose}><X size={16} /></button>
        </header>

        <div className="session-manager-list">
          {clients.map((client) => {
            const controls = getTransactionControls(client.transactionMode, client.transactionState, client.loading);
            const active = client.id === activeTabId;
            return (
              <div className={`session-client ${active ? 'active' : ''}`} data-testid="session-manager-client" key={client.id}>
                <button
                  className="session-client-main"
                  onClick={() => onSelectTab(client.id)}
                  title="이 쿼리탭으로 이동"
                >
                  <span className="session-client-icon"><Database size={14} /></span>
                  <span className="session-client-copy">
                    <span className="session-client-title">
                      {client.name}
                      {client.database && <span className="session-client-database">{client.database}</span>}
                    </span>
                    <span className="session-client-meta">
                      <span className={client.writeMode ? 'session-write' : 'session-readonly'}>
                        {client.writeMode ? <Pencil size={11} /> : <Lock size={11} />}
                        {client.writeMode ? 'Write' : 'Read-only'}
                      </span>
                      <span>{getTransactionStatusLabel(client.transactionMode, client.transactionState)}</span>
                      {client.transactionSessionId
                        ? <span className="session-id">세션 {shortSessionId(client.transactionSessionId)}</span>
                        : <span className="session-id">실행별 전용 연결</span>}
                    </span>
                  </span>
                  {active && <span className="session-active-label">현재 탭</span>}
                </button>

                <div className="session-client-actions">
                  {client.loading && client.queryId && (
                    <button className="btn btn-danger btn-xs" onClick={() => onCancelQuery(client.id, client.queryId!)}>
                      <Square size={11} /> 취소
                    </button>
                  )}
                  {client.transactionSessionId && (
                    <>
                      <button className="btn btn-secondary btn-xs" disabled={!controls.commit} onClick={() => onCommit(client.id)}>
                        <Check size={11} /> Commit
                      </button>
                      <button className="btn btn-secondary btn-xs" disabled={!controls.rollback} onClick={() => onRollback(client.id)}>
                        <RotateCcw size={11} /> Rollback
                      </button>
                      <button className="btn btn-ghost btn-xs" onClick={() => onCloseSession(client.id)}>
                        세션 종료
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <footer className="session-manager-footer">
          <span>수동 세션 종료 시 미커밋 변경 사항은 Rollback됩니다.</span>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>닫기</button>
        </footer>
      </div>
    </div>
  );
};
