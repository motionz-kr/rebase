import React, { useEffect, useReducer, useState } from 'react';
import { AlertTriangle, CheckCircle2, DownloadCloud, Info, Monitor, Moon, RefreshCw, Settings, Sun, X } from 'lucide-react';
import { useTheme } from '../lib/theme-context';
import type { ThemeSource } from '../lib/theme';
import { initialUpdateState, updateReducer, type UpdateUiState } from '../lib/updateStatus';
import { formatBytes, formatEta } from '../lib/updateFormat';

type SettingsSection = 'general' | 'theme';

const MENU: { id: SettingsSection; label: string; description: string; icon: React.ReactNode }[] = [
  { id: 'general', label: '일반', description: '버전 및 업데이트', icon: <Info size={15} /> },
  { id: 'theme', label: '테마', description: '화면 표시 방식', icon: <Sun size={15} /> },
];

const THEME_OPTIONS: { value: ThemeSource; label: string; description: string; icon: React.ReactNode }[] = [
  { value: 'light', label: '라이트', description: '밝은 배경으로 표시합니다.', icon: <Sun size={16} /> },
  { value: 'dark', label: '다크', description: '어두운 배경으로 표시합니다.', icon: <Moon size={16} /> },
  { value: 'system', label: '시스템', description: '운영체제 설정을 따릅니다.', icon: <Monitor size={16} /> },
];

function updateStatusText(state: UpdateUiState): string {
  switch (state.phase) {
    case 'checking':
      return '업데이트 확인 중';
    case 'available':
      return state.version ? `새 버전 ${state.version} 사용 가능` : '새 업데이트 사용 가능';
    case 'downloading':
      return '업데이트 다운로드 중';
    case 'downloaded':
      return state.version ? `${state.version} 설치 준비 완료` : '설치 준비 완료';
    case 'error':
      return '업데이트 확인 실패';
    default:
      return '아직 확인하지 않음';
  }
}

function UpdatePanel({ state }: { state: UpdateUiState }) {
  const downloading = state.phase === 'downloading';
  const eta = formatEta(state.bytesPerSecond ?? 0, (state.total ?? 0) - (state.transferred ?? 0));

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div>
          <h3>업데이트</h3>
          <p>현재 설치된 버전과 업데이트 상태를 확인합니다.</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={() => window.electronAPI.updateCheck()}>
          <RefreshCw size={13} /> 확인
        </button>
      </div>

      <div className="settings-info-list">
        <div className="settings-info-row">
          <span>현재 버전</span>
          <strong>v{__APP_VERSION__}</strong>
        </div>
        <div className="settings-info-row">
          <span>업데이트 상태</span>
          <strong>{updateStatusText(state)}</strong>
        </div>
        {state.phase === 'available' && state.notes && (
          <div className="settings-info-row settings-info-row-stack">
            <span>릴리스 노트</span>
            <p>{state.notes}</p>
          </div>
        )}
        {downloading && (
          <div className="settings-update-progress">
            <div className="settings-update-progress-top">
              <span>{state.percent ?? 0}%</span>
              <span>
                {formatBytes(state.transferred ?? 0)} / {formatBytes(state.total ?? 0)}
                {eta ? ` · ${eta}` : ''}
              </span>
            </div>
            <div className="update-bar">
              <div className="update-bar-fill" style={{ width: `${state.percent ?? 0}%` }} />
            </div>
          </div>
        )}
        {state.phase === 'error' && (
          <div className="settings-callout error">
            <AlertTriangle size={15} />
            <span>{state.message}</span>
          </div>
        )}
        {state.phase === 'downloaded' && (
          <div className="settings-callout ok">
            <CheckCircle2 size={15} />
            <span>재시작하면 새 버전이 적용됩니다.</span>
          </div>
        )}
      </div>

      <div className="settings-actions">
        {state.phase === 'available' && (
          <button className="btn btn-primary btn-sm" onClick={() => window.electronAPI.updateDownload()}>
            <DownloadCloud size={13} /> 다운로드
          </button>
        )}
        {state.phase === 'downloaded' && (
          <button className="btn btn-primary btn-sm" onClick={() => window.electronAPI.updateInstall()}>
            <RefreshCw size={13} /> 재시작하여 적용
          </button>
        )}
        <button className="btn btn-secondary btn-sm" onClick={() => window.electronAPI.updateOpenPage()}>
          GitHub에서 보기
        </button>
      </div>
    </section>
  );
}

export const SettingsPage: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [section, setSection] = useState<SettingsSection>('general');
  const [updateState, dispatchUpdate] = useReducer(updateReducer, initialUpdateState);
  const { source, setSource } = useTheme();

  useEffect(() => window.electronAPI.onUpdateStatus((s) => dispatchUpdate(s)), []);

  return (
    <div className="modal-overlay settings-page-overlay" onClick={onClose}>
      <div className="settings-page" role="dialog" aria-modal="true" aria-label="설정" onClick={(e) => e.stopPropagation()}>
        <div className="settings-page-head">
          <div className="settings-page-title">
            <Settings size={18} />
            <h2>설정</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="설정 닫기">
            <X size={15} />
          </button>
        </div>

        <div className="settings-page-body">
          <nav className="settings-menu" aria-label="설정 메뉴">
            {MENU.map((item) => (
              <button
                key={item.id}
                className={`settings-menu-item${section === item.id ? ' active' : ''}`}
                onClick={() => setSection(item.id)}
                aria-current={section === item.id ? 'page' : undefined}
              >
                {item.icon}
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
              </button>
            ))}
          </nav>

          <main className="settings-content">
            {section === 'general' && <UpdatePanel state={updateState} />}

            {section === 'theme' && (
              <section className="settings-section">
                <div className="settings-section-head">
                  <div>
                    <h3>테마</h3>
                    <p>앱 전체의 표시 테마를 선택합니다.</p>
                  </div>
                </div>
                <div className="settings-theme-list">
                  {THEME_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      className={`settings-theme-option${source === option.value ? ' selected' : ''}`}
                      onClick={() => setSource(option.value)}
                      aria-pressed={source === option.value}
                    >
                      <span className="settings-theme-icon">{option.icon}</span>
                      <span className="settings-theme-text">
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                      {source === option.value && <CheckCircle2 size={16} />}
                    </button>
                  ))}
                </div>
              </section>
            )}
          </main>
        </div>
      </div>
    </div>
  );
};
