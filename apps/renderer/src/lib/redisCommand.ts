// Pure helpers for the Redis command console.

/**
 * Split a raw command line into argv tokens, honouring single and double
 * quotes and backslash escapes inside double quotes. Runs of whitespace
 * outside quotes separate tokens; blank input yields an empty array.
 */
export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (inDouble) {
      if (ch === '\\' && i + 1 < input.length) {
        current += input[++i];
      } else if (ch === '"') {
        inDouble = false;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      hasToken = true;
    } else if (ch === '"') {
      inDouble = true;
      hasToken = true;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
    } else {
      current += ch;
      hasToken = true;
    }
  }

  if (hasToken) tokens.push(current);
  return tokens;
}

// Commands that wipe data or scan the whole keyspace — worth a confirm gate.
const DANGEROUS = new Set(['FLUSHALL', 'FLUSHDB', 'SWAPDB', 'KEYS']);

/** True when the first token is an operationally risky command. */
export function isDangerousCommand(args: string[]): boolean {
  if (args.length === 0) return false;
  return DANGEROUS.has(args[0].toUpperCase());
}
