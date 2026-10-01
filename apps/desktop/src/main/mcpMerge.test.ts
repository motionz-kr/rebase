import { describe, it, expect } from 'vitest';
import { mergeJsonMcp, mergeTomlMcp } from './mcpMerge';

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

  it('replaces old profile entries with one unified Rebase entry', () => {
    const existing = {
      mcpServers: {
        'rebase-profile-1': { command: '/old-engine', args: ['-mcp', 'profile-1', '-token', 'mcp'] },
        'rebase-profile-2': { command: '/old-engine', args: ['-mcp', 'profile-2', '-token', 'mcp'] },
        'rebase-custom': { command: 'custom', args: ['--config'] },
        other: { command: 'x' },
      },
    };
    const out = mergeJsonMcp(existing, 'rebase-databases', { command: '/e', args: ['-mcp', 'all'] });
    expect(out.mcpServers['rebase-profile-1']).toBeUndefined();
    expect(out.mcpServers['rebase-profile-2']).toBeUndefined();
    expect(out.mcpServers['rebase-custom']).toEqual({ command: 'custom', args: ['--config'] });
    expect(out.mcpServers.other).toEqual({ command: 'x' });
    expect(out.mcpServers['rebase-databases']).toEqual({ command: '/e', args: ['-mcp', 'all'] });
  });
});

describe('mergeTomlMcp', () => {
  it('merges into codex TOML preserving other tables', async () => {
    const existing = '[mcp_servers.other]\ncommand = "x"\n\n[settings]\nmodel = "gpt"\n';
    const out = mergeTomlMcp(existing, 'rebase-abc', { command: '/e', args: ['-mcp', 'abc'] });
    expect(out).toContain('[mcp_servers.other]');
    expect(out).toContain('rebase-abc');
    expect(out).toContain('model = "gpt"');
    // round-trips to valid TOML with our entry
    const parsed: any = (await import('@iarna/toml')).default.parse(out);
    expect(parsed.mcp_servers['rebase-abc'].command).toBe('/e');
    expect(parsed.mcp_servers.other.command).toBe('x');
  });
  it('starts from empty when there is no existing config', () => {
    const out = mergeTomlMcp('', 'rebase-x', { command: '/e', args: [] });
    expect(out).toContain('rebase-x');
  });

  it('replaces old profile entries in Codex TOML while preserving other servers', async () => {
    const existing = [
      '[mcp_servers."rebase-profile-1"]',
      'command = "/old-engine"',
      'args = ["-mcp", "profile-1", "-token", "mcp"]',
      '',
      '[mcp_servers.other]',
      'command = "x"',
      '',
      '[settings]',
      'model = "gpt"',
      '',
    ].join('\n');
    const out = mergeTomlMcp(existing, 'rebase-databases', { command: '/e', args: ['-mcp', 'all'] });
    const parsed: any = (await import('@iarna/toml')).default.parse(out);
    expect(parsed.mcp_servers['rebase-profile-1']).toBeUndefined();
    expect(parsed.mcp_servers['rebase-databases'].args).toEqual(['-mcp', 'all']);
    expect(parsed.mcp_servers.other.command).toBe('x');
    expect(parsed.settings.model).toBe('gpt');
  });
});
