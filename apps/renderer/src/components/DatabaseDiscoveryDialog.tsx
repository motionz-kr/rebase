import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Database, RefreshCw, Search, X } from 'lucide-react';
import type { DatabaseDiscoveryResult, DiscoveredDatabase } from '../global';
import { discoverySourceLabel, dockerDiscoveryMessage } from '../lib/databaseDiscovery';

type Props = {
  onSelect: (candidate: DiscoveredDatabase) => void;
  onClose: () => void;
};

const DRIVER_LABEL: Record<DiscoveredDatabase['driver'], string> = {
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  redis: 'Redis',
  sqlserver: 'SQL Server',
  mongodb: 'MongoDB',
};

export const DatabaseDiscoveryDialog: React.FC<Props> = ({ onSelect, onClose }) => {
  const [result, setResult] = useState<DatabaseDiscoveryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await window.electronAPI.discoverDatabases();
      if (!response.success || !response.data) {
        setError(response.error || '데이터베이스를 찾지 못했습니다.');
        setResult(null);
        return;
      }
      setResult(response.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '데이터베이스 검색에 실패했습니다.');
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void scan(), 0);
    return () => window.clearTimeout(timer);
  }, [scan]);

  const dockerMessage = result ? dockerDiscoveryMessage(result) : null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <section className="modal db-discovery-modal" role="dialog" aria-modal="true" aria-labelledby="db-discovery-title" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h3 id="db-discovery-title">내 PC에서 데이터베이스 찾기</h3>
            <p className="db-discovery-subtitle">로컬에서 연결할 수 있는 데이터베이스를 한 번에 검색합니다.</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="닫기"><X size={15} /></button>
        </header>

        {loading ? (
          <div className="db-discovery-state" role="status"><span className="spinner" /> 데이터베이스 검색 중…</div>
        ) : error ? (
          <div className="alert error" role="alert"><AlertTriangle size={15} /> {error}</div>
        ) : result?.candidates.length ? (
          <div className="db-discovery-results" aria-label="검색된 데이터베이스">
            {result.candidates.map((candidate) => (
              <button className="db-discovery-candidate" key={candidate.id} onClick={() => onSelect(candidate)}>
                <span className={`db-discovery-icon ${candidate.driver}`}><Database size={17} /></span>
                <span className="db-discovery-main">
                  <strong>{DRIVER_LABEL[candidate.driver]}</strong>
                  <span className="mono">{candidate.host}:{candidate.port}</span>
                </span>
                <span className="db-discovery-source">{discoverySourceLabel(candidate)}</span>
                <span className="db-discovery-add">연결 설정</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="db-discovery-state empty" role="status">
            <Search size={20} />
            <strong>연결 가능한 데이터베이스를 찾지 못했습니다.</strong>
            <span>데이터베이스가 실행 중이고 로컬 포트로 연결 가능한지 확인해 주세요.</span>
          </div>
        )}

        {dockerMessage && <p className="db-discovery-note">{dockerMessage}</p>}
        <footer className="db-discovery-footer">
          <span>검색은 이 PC의 데이터베이스 포트만 확인합니다. 비밀번호와 DB 이름은 자동 입력하지 않습니다.</span>
          <button className="btn btn-secondary btn-sm" onClick={() => void scan()} disabled={loading}>
            <RefreshCw size={13} /> 다시 검색
          </button>
        </footer>
      </section>
    </div>
  );
};
