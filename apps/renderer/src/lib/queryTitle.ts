import { isOAuthProvider, loadAgentSettings } from './agentSettings';

const MAX_TITLE_LENGTH = 48;

const SQL_TABLE_PATTERNS: Array<[RegExp, string]> = [
  [/^\s*select\b[\s\S]*?\bfrom\s+(\S+)/i, 'SELECT'],
  [/^\s*update\s+(\S+)/i, 'UPDATE'],
  [/^\s*insert\s+into\s+(\S+)/i, 'INSERT'],
  [/^\s*delete\s+from\s+(\S+)/i, 'DELETE'],
  [/^\s*create\s+table\s+(\S+)/i, 'CREATE TABLE'],
  [/^\s*alter\s+table\s+(\S+)/i, 'ALTER TABLE'],
  [/^\s*drop\s+table\s+(\S+)/i, 'DROP TABLE'],
  [/^\s*truncate\s+table\s+(\S+)/i, 'TRUNCATE'],
];

const REDIS_COMMANDS = new Set([
  'GET', 'SET', 'DEL', 'EXISTS', 'HGET', 'HSET', 'HGETALL', 'LPUSH', 'RPUSH', 'LRANGE', 'SADD', 'SMEMBERS', 'ZADD',
  'ZRANGE', 'KEYS', 'SCAN', 'TTL', 'EXPIRE', 'INFO', 'PING',
]);

export function normalizeGeneratedTitle(raw: string): string {
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';
  const cleaned = firstLine
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*]\s*/, '')
    .replace(/^`+|`+$/g, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateTitle(cleaned);
}

export function redactQueryForTitle(queryText: string): string {
  return queryText
    .replace(/'([^']|'')*'/g, "'?'")
    .replace(/"([^"]|"")*"/g, '"?"')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?');
}

export function fallbackQueryTitle(queryText: string): string {
  const text = queryText.trim();
  if (!text) return 'Untitled query';

  const mongo = text.match(/\b(?:db\.)?([A-Za-z_][\w-]*)\.(find|aggregate|count)\s*\(/i);
  if (mongo) return truncateTitle(`${mongo[1]} ${mongo[2].toLowerCase()}`);

  for (const [pattern, verb] of SQL_TABLE_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) return truncateTitle(`${verb} ${cleanIdentifier(match[1])}`);
  }
  if (/^\s*select\b/i.test(text)) return 'SELECT statement';

  const parts = text.split(/\s+/).filter(Boolean);
  const command = parts[0]?.toUpperCase();
  if (command && REDIS_COMMANDS.has(command)) {
    return truncateTitle([command, parts[1]].filter(Boolean).join(' '));
  }

  return truncateTitle(text.split(/\r?\n/)[0].replace(/\s+/g, ' '));
}

export async function generateQueryTitle(options: {
  profileId: string;
  queryText: string;
  agentEnabled: boolean;
  timeoutMs?: number;
}): Promise<string> {
  const fallback = fallbackQueryTitle(options.queryText);
  if (!options.agentEnabled || !options.queryText.trim() || typeof window === 'undefined' || !window.electronAPI) {
    return fallback;
  }

  try {
    const settings = loadAgentSettings();
    const provider = settings.provider;
    const status = isOAuthProvider(provider)
      ? await window.electronAPI.agentOAuthStatus(provider === 'openai-oauth' ? 'openai' : 'anthropic')
      : await window.electronAPI.agentKeyStatus(provider);
    const data = status?.data as Record<string, unknown> | undefined;
    const ready = !!(status?.success && (data?.present || data?.loggedIn));
    if (!ready) return fallback;

    const runId = `title-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let output = '';
    let off: () => void = () => {};
    const timeoutMs = options.timeoutMs ?? 2500;

    const done = new Promise<string>((resolve) => {
      const timer = window.setTimeout(() => {
        off();
        resolve('');
      }, timeoutMs);
      off = window.electronAPI.onAgentStreamChunk((id, chunk) => {
        if (id !== runId) return;
        if (chunk.kind === 'text') output += chunk.text ?? '';
        if (chunk.kind === 'error' || chunk.kind === 'done') {
          window.clearTimeout(timer);
          off();
          resolve(chunk.kind === 'error' ? '' : output);
        }
      });
    });

    const res = await window.electronAPI.generateNarration(
      runId,
      options.profileId,
      'You create concise saved-query titles. Return only one short title, no markdown, no quotes.',
      [{
        role: 'user',
        text: [
          'Name this database query or command for a query library.',
          'Keep it under 6 words.',
          'Use business-friendly nouns when obvious.',
          'The query text below has literal values redacted.',
          '',
          redactQueryForTitle(options.queryText),
        ].join('\n'),
      }],
      { provider: settings.provider, model: settings.model },
    );
    if (!res.success) {
      off();
      return fallback;
    }

    return normalizeGeneratedTitle(await done) || fallback;
  } catch {
    return fallback;
  }
}

function cleanIdentifier(identifier: string): string {
  return identifier.replace(/[;"'`[\]]/g, '');
}

function truncateTitle(title: string): string {
  const cleaned = title.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= MAX_TITLE_LENGTH) return cleaned;
  return `${cleaned.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}
