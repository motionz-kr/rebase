import { describe, it, expect } from 'vitest';
import { mergeJsonMcp } from './mcpMerge';

describe('mergeJsonMcp', () => {
  it('adds our key, preserving other servers and keys', () => {
    const existing = { theme: 'dark', mcpServers: { other: { command: 'x' } } };
    const out = mergeJsonMcp(existing, 'rebase-abc', { command: '/e', args: ['-mcp', 'abc'] });
    expect(out.theme).toBe('dark');
    expect(out.mcpServers.other).toEqual({ command: 'x' });
    expect(out.mcpServers['rebase-abc']).toEqual({ command: '/e', args: ['-mcp', 'abc'] });
  });
  it('is idempotent (overwrites only our key)', () => {
    const a = mergeJsonMcp({}, 'rebase-abc', { command: '/e', args: [] });
    const b = mergeJsonMcp(a, 'rebase-abc', { command: '/e2', args: [] });
    expect(b.mcpServers['rebase-abc'].command).toBe('/e2');
    expect(Object.keys(b.mcpServers)).toEqual(['rebase-abc']);
  });
});
