import { describe, test, expect } from 'vitest';
import {
  connectionsReducer,
  initialConnectionsState,
  getFocused,
  type ConnectionsState,
} from './connections';

const open = (s: ConnectionsState, profileId: string) =>
  connectionsReducer(s, { type: 'open', profileId });

describe('connectionsReducer', () => {
  test('starts empty with no focus', () => {
    expect(initialConnectionsState.order).toEqual([]);
    expect(initialConnectionsState.focusedId).toBeNull();
  });

  test('open adds a connecting entry, appends to order, and focuses it', () => {
    const s = open(initialConnectionsState, 'dev');
    expect(s.order).toEqual(['dev']);
    expect(s.byId['dev'].status).toBe('connecting');
    expect(s.focusedId).toBe('dev');
  });

  test('opening an already-open connection does not duplicate, only refocuses', () => {
    let s = open(initialConnectionsState, 'dev');
    s = connectionsReducer(s, { type: 'ready', profileId: 'dev' });
    s = open(s, 'prod'); // focus moves to prod
    expect(s.focusedId).toBe('prod');

    s = open(s, 'dev'); // re-open dev
    expect(s.order).toEqual(['dev', 'prod']); // no duplicate
    expect(s.focusedId).toBe('dev');
    expect(s.byId['dev'].status).toBe('connected'); // status preserved
  });

  test('ready marks the connection connected', () => {
    let s = open(initialConnectionsState, 'dev');
    s = connectionsReducer(s, { type: 'ready', profileId: 'dev' });
    expect(s.byId['dev'].status).toBe('connected');
  });

  test('failed marks the connection errored with a message', () => {
    let s = open(initialConnectionsState, 'dev');
    s = connectionsReducer(s, { type: 'failed', profileId: 'dev', error: 'auth failed' });
    expect(s.byId['dev'].status).toBe('error');
    expect(s.byId['dev'].error).toBe('auth failed');
  });

  test('focus changes the focused connection', () => {
    let s = open(initialConnectionsState, 'dev');
    s = open(s, 'prod');
    s = connectionsReducer(s, { type: 'focus', profileId: 'dev' });
    expect(s.focusedId).toBe('dev');
  });

  test('close removes the connection from order and byId', () => {
    let s = open(initialConnectionsState, 'dev');
    s = open(s, 'prod');
    s = connectionsReducer(s, { type: 'close', profileId: 'dev' });
    expect(s.order).toEqual(['prod']);
    expect(s.byId['dev']).toBeUndefined();
  });

  test('closing the focused connection moves focus to a remaining one', () => {
    let s = open(initialConnectionsState, 'dev');
    s = open(s, 'prod'); // focused = prod
    s = connectionsReducer(s, { type: 'close', profileId: 'prod' });
    expect(s.focusedId).toBe('dev'); // focus falls back to remaining
  });

  test('closing the last connection clears focus to null', () => {
    let s = open(initialConnectionsState, 'dev');
    s = connectionsReducer(s, { type: 'close', profileId: 'dev' });
    expect(s.order).toEqual([]);
    expect(s.focusedId).toBeNull();
  });

  test('actions on an unknown connection are a no-op', () => {
    const s = connectionsReducer(initialConnectionsState, { type: 'ready', profileId: 'ghost' });
    expect(s).toEqual(initialConnectionsState);
  });

  test('getFocused returns the focused entry or null', () => {
    expect(getFocused(initialConnectionsState)).toBeNull();
    const s = open(initialConnectionsState, 'dev');
    expect(getFocused(s)?.profileId).toBe('dev');
  });
});
