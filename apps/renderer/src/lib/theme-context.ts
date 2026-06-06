import { createContext, useContext } from 'react';
import type { ResolvedTheme, ThemeSource } from './theme';

// Context + hook live apart from the provider component so the provider file can
// export only components (react-refresh/only-export-components).
export interface ThemeContextValue {
  source: ThemeSource;
  resolved: ResolvedTheme;
  setSource: (next: ThemeSource) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}
