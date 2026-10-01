import TOML from '@iarna/toml';

export interface McpEntry {
  command: string;
  args: string[];
}

function isLegacyProfileEntry(key: string, value: any): boolean {
  const args = value?.args;
  const profileId = Array.isArray(args) && args[0] === '-mcp' ? args[1] : '';
  return key.startsWith('rebase-') && !!profileId && profileId !== 'all' && key === `rebase-${profileId}` &&
    args[2] === '-token' && args[3] === 'mcp';
}

function withoutLegacyProfileEntries(servers: Record<string, any>): Record<string, any> {
  return Object.fromEntries(Object.entries(servers).filter(([key, value]) => !isLegacyProfileEntry(key, value)));
}

// Merge our namespaced MCP server entry into a JSON client config (Claude
// Desktop / Cursor), replacing old profile-bound Rebase entries while
// preserving every unrelated server and top-level key.
export function mergeJsonMcp(existing: unknown, key: string, entry: McpEntry): any {
  const cfg: any = existing && typeof existing === 'object' ? { ...(existing as object) } : {};
  cfg.mcpServers = { ...withoutLegacyProfileEntries(cfg.mcpServers || {}), [key]: entry };
  return cfg;
}

// Merge our entry into a codex TOML config, replacing old profile-bound
// Rebase entries while preserving other tables/keys.
export function mergeTomlMcp(existingToml: string, key: string, entry: McpEntry): string {
  const cfg: any = existingToml.trim() ? TOML.parse(existingToml) : {};
  cfg.mcp_servers = { ...withoutLegacyProfileEntries(cfg.mcp_servers || {}), [key]: { command: entry.command, args: entry.args } };
  return TOML.stringify(cfg);
}
