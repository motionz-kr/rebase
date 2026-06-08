export function parseArgs(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

export function parseEnv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

export function validateServer(s: { name: string; command: string }): string {
  if (!s.name.trim()) return '서버 이름을 입력하세요.';
  if (!s.command.trim()) return '실행 명령을 입력하세요.';
  return '';
}
