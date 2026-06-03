import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { mergeJsonMcp, mergeTomlMcp, McpEntry } from './mcpMerge';

type Format = 'json' | 'toml';
interface ClientDef {
  id: string;
  label: string;
  format: Format;
  configPath: () => string | null;
}

function appDataBase(): string | null {
  if (process.env.APPDATA) return process.env.APPDATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return null;
}

// Known external MCP clients and where their configs live.
export const CLIENTS: ClientDef[] = [
  {
    id: 'claude',
    label: 'Claude Desktop',
    format: 'json',
    configPath: () => {
      const base = appDataBase();
      return base ? path.join(base, 'Claude', 'claude_desktop_config.json') : null;
    },
  },
  {
    id: 'cursor',
    label: 'Cursor',
    format: 'json',
    configPath: () => path.join(os.homedir(), '.cursor', 'mcp.json'),
  },
  {
    id: 'codex',
    label: 'Codex',
    format: 'toml',
    configPath: () => path.join(os.homedir(), '.codex', 'config.toml'),
  },
];

// "present" = the client's config file or its directory exists (installed).
export function detectClients(): { id: string; label: string; present: boolean }[] {
  return CLIENTS.map((c) => {
    const p = c.configPath();
    const present = !!p && (fs.existsSync(p) || fs.existsSync(path.dirname(p)));
    return { id: c.id, label: c.label, present };
  });
}

// Safely merge our namespaced entry into the client's config: back up the
// existing file, preserve all other keys, validate, then write.
export function applyClient(
  clientId: string,
  key: string,
  entry: McpEntry
): { ok: boolean; path?: string; backup?: string; error?: string } {
  const def = CLIENTS.find((c) => c.id === clientId);
  if (!def) return { ok: false, error: `unknown client: ${clientId}` };
  const file = def.configPath();
  if (!file) return { ok: false, error: 'this client is not supported on your platform' };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existed = fs.existsSync(file);
    const raw = existed ? fs.readFileSync(file, 'utf8') : '';
    let backup: string | undefined;
    if (existed) {
      backup = `${file}.rebase-bak-${Date.now()}`;
      fs.copyFileSync(file, backup);
    }
    let next: string;
    if (def.format === 'json') {
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      next = JSON.stringify(mergeJsonMcp(parsed, key, entry), null, 2);
    } else {
      next = mergeTomlMcp(raw, key, entry);
    }
    fs.writeFileSync(file, next, 'utf8');
    return { ok: true, path: file, backup };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
