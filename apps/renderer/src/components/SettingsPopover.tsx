import React, { useEffect, useRef, useState } from 'react';
import { Settings, Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from '../lib/ThemeContext';
import type { ThemeSource } from '../lib/theme';

const OPTIONS: { value: ThemeSource; label: string; icon: React.ReactNode }[] = [
  { value: 'light', label: '라이트', icon: <Sun size={14} /> },
  { value: 'dark', label: '다크', icon: <Moon size={14} /> },
  { value: 'system', label: '시스템', icon: <Monitor size={14} /> },
];

export const SettingsPopover: React.FC = () => {
  const { source, setSource } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="settings-popover-wrap" ref={ref}>
      <button
        className={`icon-btn${open ? ' active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="설정"
      >
        <Settings size={14} />
      </button>
      {open && (
        <div className="settings-popover" role="menu">
          <div className="settings-popover-label">테마</div>
          <div className="theme-segmented">
            {OPTIONS.map((o) => (
              <button
                key={o.value}
                className={`theme-seg${source === o.value ? ' selected' : ''}`}
                onClick={() => setSource(o.value)}
                role="menuitemradio"
                aria-checked={source === o.value}
              >
                {o.icon}
                <span>{o.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
