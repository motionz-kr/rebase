import type { DomainEntry } from './domainGlossary';

/**
 * Build a tool-free /agent/complete prompt that asks the model to propose
 * business meanings for the given schema. Only metadata (table/column names)
 * is sent — never row data — so no data-exposure consent is required.
 */
export function buildFillPrompt(
  tables: string[],
  columnsByTable: Record<string, string[]>,
  userText?: string,
): { system: string; user: string } {
  const system =
    '너는 DB 도메인 전문가다. 주어진 스키마(테이블/컬럼명)에 대해 각 항목의 업무 의미를 한국어로 추정하라. ' +
    '반드시 JSON 배열만 출력하라. 각 원소는 {"kind":"table"|"column","table":"<테이블>","column":"<컬럼 또는 빈문자열>","meaning":"<업무 의미>"} 형식이다. ' +
    '확실하지 않으면 그 항목은 생략하라. 설명 문장 없이 JSON 배열만 출력하라.';

  const lines: string[] = ['스키마:'];
  for (const t of tables) {
    lines.push(`- 테이블 ${t}: ${(columnsByTable[t] ?? []).join(', ')}`);
  }
  if (userText && userText.trim()) {
    lines.push('', '사용자 설명(우선 반영):', userText.trim());
  }
  return { system, user: lines.join('\n') };
}

/** Extract a JSON array of DomainEntry from a model response (lenient). */
export function parseFillResponse(text: string): DomainEntry[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(v)) return [];
    return v
      .filter((e) => e && typeof e.meaning === 'string' && typeof e.table === 'string')
      .map((e) => ({
        kind: e.kind === 'column' ? 'column' : 'table',
        table: String(e.table),
        column: typeof e.column === 'string' ? e.column : '',
        meaning: String(e.meaning),
      }));
  } catch {
    return [];
  }
}
