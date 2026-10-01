import { describe, it, expect } from 'vitest';
import { buildMcpEntry, mcpServerKey, buildJsonSnippet } from './mcpConfig';

describe('mcpConfig', () => {
  it('uses one shared server key for all exposed profiles', () => {
    expect(mcpServerKey()).toBe('rebase-databases');
  });

  it('builds one unified stdio entry without a placeholder auth token', () => {
    const entry = buildMcpEntry('/Apps/Rebase/bin/app-engine');
    expect(entry.command).toBe('/Apps/Rebase/bin/app-engine');
    expect(entry.args).toEqual(['-mcp', 'all']);
  });

  it('builds a JSON snippet with one Rebase entry', () => {
    const snippet = JSON.parse(buildJsonSnippet('/e'));
    expect(Object.keys(snippet.mcpServers)).toEqual(['rebase-databases']);
    expect(snippet.mcpServers['rebase-databases'].command).toBe('/e');
    expect(snippet.mcpServers['rebase-databases'].args).toEqual(['-mcp', 'all']);
  });
});
