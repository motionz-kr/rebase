import React, { useEffect, useReducer, useState } from 'react';
import { Download, X, Loader2, RefreshCw } from 'lucide-react';
import { updateReducer, initialUpdateState } from '../lib/updateStatus';

// Top-right Update button + progress modal. Visible only when an update is
// available/downloading/downloaded. On unsigned macOS the main process opens
// the Releases page instead of downloading (the modal still shows briefly).
export const UpdateButton: React.FC = () => {
  const [state, dispatch] = useReducer(updateReducer, initialUpdateState);
  const [open, setOpen] = useState(false);

  useEffect(() => window.electronAPI.onUpdateStatus((s) => dispatch(s)), []);

  const visible = state.phase === 'available' || state.phase === 'downloading' || state.phase === 'downloaded';
  if (!visible) return null;

  const onUpdate = () => {
    setOpen(true);
    if (state.phase === 'available') void window.electronAPI.updateDownload();
  };

  return (
    <>
      <button className="btn btn-primary btn-sm update-pill" onClick={onUpdate} title="업데이트 사용 가능">
        <Download size={14} /> 업데이트
      </button>
      {open && (
        <div className="update-overlay" onClick={() => state.phase !== 'downloading' && setOpen(false)}>
          <div className="update-modal" onClick={(e) => e.stopPropagation()}>
            <div className="update-modal-head">
              <span>업데이트{state.version ? ` · ${state.version}` : ''}</span>
              {state.phase !== 'downloading' && (
                <button className="icon-btn" onClick={() => setOpen(false)} title="닫기">
                  <X size={15} />
                </button>
              )}
            </div>
            <div className="update-modal-body">
              {state.phase === 'available' && (
                <p className="update-line">
                  <Loader2 size={15} className="spin" /> 업데이트를 준비하는 중…
                </p>
              )}
              {state.phase === 'downloading' && (
                <>
                  <p className="update-line">
                    <Loader2 size={15} className="spin" /> 다운로드 중… {state.percent ?? 0}%
                  </p>
                  <div className="update-bar">
                    <div className="update-bar-fill" style={{ width: `${state.percent ?? 0}%` }} />
                  </div>
                </>
              )}
              {state.phase === 'downloaded' && <p className="update-line">다운로드 완료. 재시작하면 적용됩니다.</p>}
              {state.phase === 'error' && <p className="update-line err">{state.message}</p>}
            </div>
            <div className="update-modal-actions">
              {state.phase === 'downloaded' && (
                <button className="btn btn-primary btn-sm" onClick={() => window.electronAPI.updateInstall()}>
                  <RefreshCw size={13} /> 재시작하여 설치
                </button>
              )}
              {state.phase === 'error' && (
                <>
                  <button className="btn btn-secondary btn-sm" onClick={() => window.electronAPI.updateOpenPage()}>
                    GitHub에서 받기
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => window.electronAPI.updateDownload()}>
                    다시 시도
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
