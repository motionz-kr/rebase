import TOML from '@iarna/toml';

export interface McpEntry {
  command: string;
  args: string[];
}

// Merge our namespaced MCP server entry into a JSON client config (Claude
// Desktop / Cursor), preserving every other server and top-level key.
export function mergeJsonMcp(existing: unknown, key: string, entry: McpEntry): any {
  const cfg: any = existing && typeof existing === 'object' ? { ...(existing as object) } : {};
  cfg.mcpServers = { ...(cfg.mcpServers || {}), [key]: entry };
  return cfg;
}

// Merge our entry into a codex TOML config, preserving other tables/keys.
export function mergeTomlMcp(existingToml: string, key: string, entry: McpEntry): string {
  const cfg: any = existingToml.trim() ? TOML.parse(existingToml) : {};
  cfg.mcp_servers = { ...(cfg.mcp_servers || {}), [key]: { command: entry.command, args: entry.args } };
  return TOML.stringify(cfg);
}
