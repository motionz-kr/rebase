import type { UpdateStatus } from '../global';

export interface UpdateUiState {
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  notes?: string;
  percent?: number;
  message?: string;
}

export const initialUpdateState: UpdateUiState = { phase: 'idle' };

export function updateReducer(state: UpdateUiState, s: UpdateStatus): UpdateUiState {
  switch (s.kind) {
    case 'checking':
      return { phase: 'checking', version: state.version };
    case 'available':
      return { phase: 'available', version: s.version, notes: s.notes };
    case 'not-available':
      return { phase: 'idle' };
    case 'progress':
      return { phase: 'downloading', version: state.version, percent: s.percent };
    case 'downloaded':
      return { phase: 'downloaded', version: s.version };
    case 'error':
      return { phase: 'error', message: s.message };
    default:
      return state;
  }
}
