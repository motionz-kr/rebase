import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { parseInjectedTheme, type ResolvedTheme, type ThemeSource } from './theme';

interface ThemeContextValue {
  source: ThemeSource;
  resolved: ResolvedTheme;
  setSource: (next: ThemeSource) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function applyResolved(resolved: ResolvedTheme): void {
  document.documentElement.setAttribute('data-theme', resolved);
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const initial = parseInjectedTheme(window.__THEME__);
  const [source, setSourceState] = useState<ThemeSource>(initial.source);
  const [resolved, setResolved] = useState<ResolvedTheme>(initial.resolved);

  // Keep the <html data-theme> attribute in sync with the resolved theme.
  useEffect(() => {
    applyResolved(resolved);
  }, [resolved]);

  // Main broadcasts on user changes (confirmation) and OS changes (system mode).
  useEffect(() => {
    const unsubscribe = window.electronAPI.onThemeUpdated((payload) => {
      const p = parseInjectedTheme(payload);
      setSourceState(p.source);
      setResolved(p.resolved);
    });
    return unsubscribe;
  }, []);

  const setSource = useCallback((next: ThemeSource) => {
    setSourceState(next); // optimistic; reconciled by the broadcast below
    window.electronAPI
      .setThemeSource(next)
      .then((payload) => {
        const p = parseInjectedTheme(payload);
        setSourceState(p.source);
        setResolved(p.resolved);
      })
      .catch(() => {
        // Persist/IPC failure: keep the optimistic value; the next broadcast reconciles.
      });
  }, []);

  return (
    <ThemeContext.Provider value={{ source, resolved, setSource }}>
      {children}
    </ThemeContext.Provider>
  );
};

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}
