// Pure builders for the single shared MCP stdio server entry.

export const mcpServerKey = () => 'rebase-databases';

export interface McpEntry {
  command: string;
  args: string[];
}

export function buildMcpEntry(enginePath: string): McpEntry {
  return { command: enginePath, args: ['-mcp', 'all'] };
}

// Full snippet for JSON-config clients (Claude Desktop / Cursor).
export function buildJsonSnippet(enginePath: string): string {
  return JSON.stringify({ mcpServers: { [mcpServerKey()]: buildMcpEntry(enginePath) } }, null, 2);
}
