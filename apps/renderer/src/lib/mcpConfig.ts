// Pure builders for the MCP stdio server entry a client config needs.
// The client launches the bundled engine binary in -mcp mode for a profile.

export const mcpServerKey = (connId: string) => `rebase-${connId}`;

export interface McpEntry {
  command: string;
  args: string[];
}

export function buildMcpEntry(enginePath: string, profileId: string): McpEntry {
  return { command: enginePath, args: ['-mcp', profileId, '-token', 'mcp', '-handshake', '/dev/null'] };
}

// Full snippet for JSON-config clients (Claude Desktop / Cursor).
export function buildJsonSnippet(enginePath: string, connId: string): string {
  return JSON.stringify({ mcpServers: { [mcpServerKey(connId)]: buildMcpEntry(enginePath, connId) } }, null, 2);
}
