import { useState } from 'react';
import type { AnalyzeResult } from '../global';
import { toRiskView, requiresAcknowledgement, riskClass } from '../lib/safeMode';

interface Props {
  result: AnalyzeResult;
  safeMode: boolean;
  onRun: () => void;
  onCancel: () => void;
}

export function RiskConfirmDialog({ result, safeMode, onRun, onCancel }: Props) {
  const v = toRiskView(result);
  const needAck = requiresAcknowledgement(result, safeMode);
  const [ack, setAck] = useState(false);
  const canRun = !needAck || ack;

  const copy = (text: string) => navigator.clipboard?.writeText(text);

  return (
    <div className="risk-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="risk-dialog">
        <header className={`risk-header ${riskClass(v.level)}`}>
          <span className="risk-badge">{v.label}</span>
          <span className="risk-verb">{v.verb} · {v.table || '—'}</span>
        </header>

        <section className="risk-body">
          <dl className="risk-facts">
            <dt>예상 영향 row</dt><dd>{v.affectedText}</dd>
            {v.tenantMissing && <><dt>tenant 조건</dt><dd className="risk-warn-text">누락</dd></>}
          </dl>

          {v.reasons.length > 0 && (
            <ul className="risk-reasons">
              {v.reasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          )}

          {v.previewSql && (
            <div className="risk-section">
              <div className="risk-section-head">
                <span>SELECT Preview</span>
                <button onClick={() => copy(v.previewSql)}>복사</button>
              </div>
              <pre className="risk-sql">{v.previewSql}</pre>
            </div>
          )}

          {v.hasRollback ? (
            <div className="risk-section">
              <div className="risk-section-head">
                <span>Rollback SQL</span>
                <button onClick={() => copy(v.rollbackSql)}>복사</button>
              </div>
              <pre className="risk-sql risk-rollback">{v.rollbackSql}</pre>
            </div>
          ) : v.rollbackNote ? (
            <p className="risk-note">{v.rollbackNote}</p>
          ) : null}
        </section>

        <footer className="risk-footer">
          {needAck && (
            <label className="risk-ack">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              강제 실행 (운영 DB · 위험을 확인했습니다)
            </label>
          )}
          <div className="risk-actions">
            <button onClick={onCancel}>취소</button>
            <button className="risk-run" disabled={!canRun} onClick={onRun}>실행</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
