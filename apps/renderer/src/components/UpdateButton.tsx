import React, { useEffect, useReducer, useState } from 'react';
import { X, Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import { updateReducer, initialUpdateState } from '../lib/updateStatus';
import { formatBytes, formatEta } from '../lib/updateFormat';

// Floating auto-update card (top-right). The main process auto-downloads on
// startup when an update is available, so this appears on its own — no click —
// showing a progress bar + downloaded/total size + ETA, then a restart prompt.
// "나중에" hides it (the download keeps going; it reappears when ready to install).
export const UpdateButton: React.FC = () => {
  const [state, dispatch] = useReducer(updateReducer, initialUpdateState);
  // Remember which phase the user dismissed; a new phase (e.g. download finished)
  // un-dismisses on its own, so the next step is shown without an effect.
  const [dismissedPhase, setDismissedPhase] = useState<string | null>(null);

  useEffect(() => window.electronAPI.onUpdateStatus((s) => dispatch(s)), []);

  const active =
    state.phase === 'available' || state.phase === 'downloading' || state.phase === 'downloaded' || state.phase === 'error';
  if (!active || dismissedPhase === state.phase) return null;
  const dismiss = () => setDismissedPhase(state.phase);

  const downloading = state.phase === 'available' || state.phase === 'downloading';
  const eta = formatEta(state.bytesPerSecond ?? 0, (state.total ?? 0) - (state.transferred ?? 0));

  return (
    <div className="update-card">
      {downloading && (
        <>
          <div className="update-card-row">
            <Loader2 size={14} className="spin" />
            <span className="update-card-title">업데이트 다운로드{state.version ? ` · ${state.version}` : ''}</span>
            <span className="update-card-pct">{state.percent ?? 0}%</span>
            <button className="icon-btn" onClick={dismiss} title="나중에">
              <X size={14} />
            </button>
          </div>
          <div className="update-bar">
            <div className="update-bar-fill" style={{ width: `${state.percent ?? 0}%` }} />
          </div>
          <div className="update-card-meta">
            {formatBytes(state.transferred ?? 0)} / {formatBytes(state.total ?? 0)}
            {eta ? ` · ${eta}` : ''}
          </div>
        </>
      )}

      {state.phase === 'downloaded' && (
        <>
          <div className="update-card-row">
            <span className="update-card-title">업데이트 준비 완료{state.version ? ` · ${state.version}` : ''}</span>
            <button className="icon-btn" onClick={dismiss} title="나중에">
              <X size={14} />
            </button>
          </div>
          <div className="update-card-meta">재시작하면 새 버전이 적용됩니다.</div>
          <button className="btn btn-primary btn-sm update-card-action" onClick={() => window.electronAPI.updateInstall()}>
            <RefreshCw size={13} /> 재시작하여 적용
          </button>
        </>
      )}

      {state.phase === 'error' && (
        <>
          <div className="update-card-row">
            <AlertTriangle size={14} className="warn" />
            <span className="update-card-title">업데이트 오류</span>
            <button className="icon-btn" onClick={dismiss} title="닫기">
              <X size={14} />
            </button>
          </div>
          <div className="update-card-meta err">{state.message}</div>
          <div className="update-card-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => window.electronAPI.updateOpenPage()}>
              GitHub에서 받기
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => window.electronAPI.updateDownload()}>
              다시 시도
            </button>
          </div>
        </>
      )}
    </div>
  );
};
