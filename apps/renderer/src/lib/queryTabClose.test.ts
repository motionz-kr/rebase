import { describe, expect, it } from 'vitest';
import { canCloseQueryTabs, getQueryTabCloseIds, getRemainingActiveTabId } from './queryTabClose';

const tabs = ['a', 'b', 'c', 'd'].map((id) => ({ id }));

describe('running tab protection', () => {
  const clients = tabs.map((tab) => ({ ...tab, loading: tab.id === 'b' }));
  it('blocks closing a running tab or a range containing it', () => {
    expect(canCloseQueryTabs(clients, 'b', 'current')).toBe(false);
    expect(canCloseQueryTabs(clients, 'a', 'all')).toBe(false);
    expect(canCloseQueryTabs(clients, 'a', 'right')).toBe(false);
  });
  it('allows closing idle tabs while the running tab survives', () => {
    expect(canCloseQueryTabs(clients, 'b', 'others')).toBe(true);
    expect(canCloseQueryTabs(clients, 'b', 'left')).toBe(true);
    expect(canCloseQueryTabs(clients, 'b', 'right')).toBe(true);
  });
  it('disables empty scopes and permits closing after execution ends', () => {
    expect(canCloseQueryTabs(clients, 'a', 'left')).toBe(false);
    expect(canCloseQueryTabs(clients.map((tab) => ({ ...tab, loading: false })), 'b', 'all')).toBe(true);
  });
});

describe('query tab close scope', () => {
  it.each([
    ['current', ['b']],
    ['others', ['a', 'c', 'd']],
    ['left', ['a']],
    ['right', ['c', 'd']],
    ['all', ['a', 'b', 'c', 'd']],
  ] as const)('selects %s relative to the clicked tab', (scope, expected) => {
    expect(getQueryTabCloseIds(tabs, 'b', scope)).toEqual(expected);
  });

  it('handles the first, last, and only tab', () => {
    expect(getQueryTabCloseIds(tabs, 'a', 'left')).toEqual([]);
    expect(getQueryTabCloseIds(tabs, 'd', 'right')).toEqual([]);
    expect(getQueryTabCloseIds([{ id: 'a' }], 'a', 'others')).toEqual([]);
    expect(getQueryTabCloseIds([{ id: 'a' }], 'a', 'current')).toEqual(['a']);
  });

  it('ignores a stale target for every scope and leaves input unchanged', () => {
    for (const scope of ['current', 'others', 'left', 'right', 'all'] as const) {
      expect(getQueryTabCloseIds(tabs, 'missing', scope)).toEqual([]);
    }
    expect(tabs.map((tab) => tab.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('active tab after close', () => {
  it('preserves an active tab outside the closed range', () => {
    expect(getRemainingActiveTabId(tabs, 'd', ['a', 'b'])).toBe('d');
  });

  it('selects the next surviving tab, or the previous one at the end', () => {
    expect(getRemainingActiveTabId(tabs, 'b', ['b'])).toBe('c');
    expect(getRemainingActiveTabId(tabs, 'b', ['b', 'c'])).toBe('d');
    expect(getRemainingActiveTabId(tabs, 'd', ['c', 'd'])).toBe('b');
  });

  it('returns null when all tabs close and recovers a stale active ID', () => {
    expect(getRemainingActiveTabId(tabs, 'b', ['a', 'b', 'c', 'd'])).toBeNull();
    expect(getRemainingActiveTabId(tabs, 'missing', ['a'])).toBe('b');
    expect(getRemainingActiveTabId([], 'missing', [])).toBeNull();
  });
});
