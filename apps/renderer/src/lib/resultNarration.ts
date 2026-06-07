import { buildSummary, formatSummary, type SummaryFormat } from './templateSummary';

export type NarrationPurpose = 'jira' | 'slack' | 'cs' | 'dev' | 'customer';

export interface NarrationInput {
  sql: string;
  columns: string[];
  rows: unknown[][];   // already capped by the caller
  rowCount: number;    // total rows (may exceed rows.length)
}

export interface NarrationPrompt {
  system: string;
  user: string;
}

const GROUND = '제공된 쿼리 결과 데이터만 근거로 사용하고, 데이터에 없는 내용은 추측하지 마세요. 한국어로 작성하세요.';

export const NARRATION_PURPOSES: { id: NarrationPurpose; label: string; system: string }[] = [
  {
    id: 'jira', label: 'Jira 댓글',
    system: `당신은 DB 조회 결과를 Jira 댓글로 정리하는 엔지니어입니다. 마크다운으로 "## 확인 결과", "## 특이사항", "## 후속 조치" 세 섹션을 작성합니다. 수치는 목록으로 정리합니다. ${GROUND}`,
  },
  {
    id: 'slack', label: 'Slack 공유',
    system: `당신은 DB 조회 결과를 Slack에 공유하는 동료입니다. 2~4문장의 간결한 단락으로 핵심 수치와 특이사항을 전달합니다. 과한 마크다운은 피합니다. ${GROUND}`,
  },
  {
    id: 'cs', label: 'CS 답변',
    system: `당신은 고객 문의에 답하는 CS 담당자입니다. 비기술적이고 정중한 톤으로, 확인된 사실과 진행 예정 조치를 안내합니다. 내부 용어/컬럼명은 노출하지 않습니다. ${GROUND}`,
  },
  {
    id: 'dev', label: '개발 원인 분석',
    system: `당신은 데이터 이상을 분석하는 개발자입니다. 관찰된 사실, 추정 원인, 재현/확인 방법, 개선 제안을 기술적으로 정리합니다. ${GROUND}`,
  },
  {
    id: 'customer', label: '고객 안내',
    system: `당신은 고객에게 상황을 안내하는 담당자입니다. 완곡하고 안심을 주는 톤으로, 현재 확인된 상황과 처리 방향을 쉽게 설명합니다. 민감한 내부 데이터는 노출하지 않습니다. ${GROUND}`,
  },
];

function serializeRows(columns: string[], rows: unknown[][]): string {
  const head = columns.join(' | ');
  const body = rows
    .map((r) => columns.map((_, i) => (r[i] == null ? 'NULL' : String(r[i]))).join(' | '))
    .join('\n');
  return `${head}\n${body}`;
}

export function buildNarrationPrompt(purpose: NarrationPurpose, input: NarrationInput): NarrationPrompt {
  const def = NARRATION_PURPOSES.find((p) => p.id === purpose) ?? NARRATION_PURPOSES[0];
  const shown = input.rows.length;
  const user =
    `실행한 SQL:\n${input.sql}\n\n` +
    `컬럼: ${input.columns.join(', ')}\n` +
    `총 ${input.rowCount}행 (상위 ${shown}행 표시):\n` +
    serializeRows(input.columns, input.rows) +
    `\n\n위 결과를 바탕으로 ${def.label} 문장을 작성하세요.`;
  return { system: def.system, user };
}

export function deterministicNarration(purpose: NarrationPurpose, input: NarrationInput): string {
  const fmt: SummaryFormat = purpose === 'jira' ? 'jira' : purpose === 'slack' ? 'slack' : 'plain';
  const s = buildSummary('쿼리 결과 요약', input.columns, input.rows);
  return formatSummary(s, fmt);
}
