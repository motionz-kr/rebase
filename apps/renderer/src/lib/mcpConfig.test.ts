import { describe, it, expect } from 'vitest';
import { buildMcpEntry, mcpServerKey, buildJsonSnippet } from './mcpConfig';

describe('mcpConfig', () => {
  it('namespaces the server key by connection id', () => {
    expect(mcpServerKey('abc')).toBe('rebase-abc');
  });
  it('builds a stdio entry with engine path + profile args', () => {
    const e = buildMcpEntry('/Apps/Rebase/bin/app-engine', 'abc');
    expect(e.command).toBe('/Apps/Rebase/bin/app-engine');
    expect(e.args).toEqual(['-mcp', 'abc', '-token', 'mcp', '-handshake', '/dev/null']);
  });
  it('builds a JSON snippet under mcpServers', () => {
    const snip = JSON.parse(buildJsonSnippet('/e', 'abc'));
    expect(snip.mcpServers['rebase-abc'].command).toBe('/e');
    expect(snip.mcpServers['rebase-abc'].args[1]).toBe('abc');
  });
});
