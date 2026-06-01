// Pure state model for holding multiple open database connections at once.
// It tracks which connections are open, their status, and which one is focused.
// Per-connection editor/results state is preserved by keeping the focused
// components mounted in the UI, so it does not live here.

export type ConnectionStatus = 'connecting' | 'connected' | 'error';

export interface ConnectionEntry {
  profileId: string;
  status: ConnectionStatus;
  error?: string;
}

export interface ConnectionsState {
  order: string[]; // profileIds in display order
  byId: Record<string, ConnectionEntry>;
  focusedId: string | null;
}

export const initialConnectionsState: ConnectionsState = {
  order: [],
  byId: {},
  focusedId: null,
};

export type ConnectionsAction =
  | { type: 'open'; profileId: string }
  | { type: 'ready'; profileId: string }
  | { type: 'failed'; profileId: string; error: string }
  | { type: 'focus'; profileId: string }
  | { type: 'close'; profileId: string };

export function connectionsReducer(
  state: ConnectionsState,
  action: ConnectionsAction
): ConnectionsState {
  switch (action.type) {
    case 'open': {
      const id = action.profileId;
      if (state.byId[id]) {
        // Already open — just refocus, preserving its status and editor state.
        return { ...state, focusedId: id };
      }
      return {
        order: [...state.order, id],
        byId: { ...state.byId, [id]: { profileId: id, status: 'connecting' } },
        focusedId: id,
      };
    }

    case 'ready': {
      const entry = state.byId[action.profileId];
      if (!entry) return state;
      return {
        ...state,
        byId: { ...state.byId, [action.profileId]: { ...entry, status: 'connected', error: undefined } },
      };
    }

    case 'failed': {
      const entry = state.byId[action.profileId];
      if (!entry) return state;
      return {
        ...state,
        byId: { ...state.byId, [action.profileId]: { ...entry, status: 'error', error: action.error } },
      };
    }

    case 'focus': {
      if (!state.byId[action.profileId]) return state;
      return { ...state, focusedId: action.profileId };
    }

    case 'close': {
      const id = action.profileId;
      if (!state.byId[id]) return state;
      const idx = state.order.indexOf(id);
      const order = state.order.filter((x) => x !== id);
      const byId = { ...state.byId };
      delete byId[id];
      let focusedId = state.focusedId;
      if (focusedId === id) {
        // Fall back to the previous connection in order, else the first, else none.
        focusedId = order[idx - 1] ?? order[0] ?? null;
      }
      return { order, byId, focusedId };
    }

    default:
      return state;
  }
}

export function getFocused(state: ConnectionsState): ConnectionEntry | null {
  return state.focusedId ? state.byId[state.focusedId] ?? null : null;
}
