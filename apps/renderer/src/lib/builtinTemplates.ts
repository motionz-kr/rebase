import type { TemplateDef } from './templateTypes';

export const BUILTIN_TEMPLATES: TemplateDef[] = [
  {
    id: 'dup-by-column', source: 'builtin', category: 'CS 조사',
    name: '컬럼 기준 중복 행 찾기',
    description: '한 테이블에서 특정 컬럼 값이 중복되는 행을 찾습니다. phone/chartNumber 중복 환자, 엑셀 업로드 오류 조사에 사용합니다.',
    roles: ['tenant', 'soft_delete'],
    params: [
      { name: 'table', label: '테이블', kind: 'identifier', identifierKind: 'table', required: true },
      { name: 'dupColumn', label: '중복 검사 컬럼', kind: 'identifier', identifierKind: 'column', required: true },
      { name: 'tenantValue', label: 'tenant 값 (선택)', kind: 'value', valueType: 'number' },
    ],
    sql: `SELECT {{dupColumn}}, COUNT(*) AS duplicateCount
FROM {{table}}
WHERE {{dupColumn}} IS NOT NULL AND {{dupColumn}} <> ''
[[  AND {{role:tenant}} = :tenantValue]]
[[  AND {{role:soft_delete}} IS NULL]]
GROUP BY {{dupColumn}}
HAVING COUNT(*) > 1
ORDER BY duplicateCount DESC`,
  },
  {
    id: 'entity-history', source: 'builtin', category: 'CS 조사',
    name: '특정 엔티티 ID 내역 조회',
    description: '특정 ID(예: 환자 ID)에 해당하는 행을 조회합니다. 특정 환자의 내원/메시지 이력 조사에 사용합니다.',
    roles: ['soft_delete'],
    params: [
      { name: 'table', label: '테이블', kind: 'identifier', identifierKind: 'table', required: true },
      { name: 'idColumn', label: 'ID 컬럼', kind: 'identifier', identifierKind: 'column', required: true },
      { name: 'idValue', label: 'ID 값', kind: 'value', valueType: 'string', required: true },
    ],
    sql: `SELECT *
FROM {{table}}
WHERE {{idColumn}} = :idValue
[[  AND {{role:soft_delete}} IS NULL]]
LIMIT 500`,
  },
  {
    id: 'rows-by-value', source: 'builtin', category: 'CS 조사',
    name: '컬럼 값으로 행 조회',
    description: '특정 컬럼이 입력한 값과 일치하는 행을 조회합니다. 전화번호/차트번호 등으로 환자를 찾을 때 사용합니다.',
    roles: ['tenant', 'soft_delete'],
    params: [
      { name: 'table', label: '테이블', kind: 'identifier', identifierKind: 'table', required: true },
      { name: 'column', label: '검색 컬럼', kind: 'identifier', identifierKind: 'column', required: true },
      { name: 'value', label: '값', kind: 'value', valueType: 'string', required: true },
      { name: 'tenantValue', label: 'tenant 값 (선택)', kind: 'value', valueType: 'number' },
    ],
    sql: `SELECT *
FROM {{table}}
WHERE {{column}} = :value
[[  AND {{role:tenant}} = :tenantValue]]
[[  AND {{role:soft_delete}} IS NULL]]
LIMIT 500`,
  },
  {
    id: 'group-count-recent', source: 'builtin', category: '운영 점검',
    name: '그룹별 최근 N일 집계',
    description: '최근 N일간 특정 컬럼 기준으로 행 수를 집계합니다. 병원별 최근 30일 내원 수 확인 등에 사용합니다. (MySQL — INTERVAL 문법)',
    roles: ['soft_delete'],
    params: [
      { name: 'table', label: '테이블', kind: 'identifier', identifierKind: 'table', required: true },
      { name: 'groupColumn', label: '그룹 컬럼', kind: 'identifier', identifierKind: 'column', required: true },
      { name: 'dateColumn', label: '날짜 컬럼', kind: 'identifier', identifierKind: 'column', required: true },
      { name: 'days', label: '최근 N일', kind: 'value', valueType: 'number', required: true, default: '30' },
    ],
    sql: `SELECT {{groupColumn}}, COUNT(*) AS cnt
FROM {{table}}
WHERE {{dateColumn}} >= (CURRENT_DATE - INTERVAL :days DAY)
[[  AND {{role:soft_delete}} IS NULL]]
GROUP BY {{groupColumn}}
ORDER BY cnt DESC`,
  },
  {
    id: 'null-check', source: 'builtin', category: '운영 점검',
    name: '컬럼 NULL/빈값 점검',
    description: '특정 컬럼이 NULL이거나 빈 문자열인 행을 찾습니다. 엑셀 업로드 이후 이상 데이터 점검에 사용합니다.',
    roles: ['soft_delete'],
    params: [
      { name: 'table', label: '테이블', kind: 'identifier', identifierKind: 'table', required: true },
      { name: 'column', label: '점검 컬럼', kind: 'identifier', identifierKind: 'column', required: true },
    ],
    sql: `SELECT *
FROM {{table}}
WHERE ({{column}} IS NULL OR {{column}} = '')
[[  AND {{role:soft_delete}} IS NULL]]
LIMIT 500`,
  },
  {
    id: 'recent-rows', source: 'builtin', category: '운영 점검',
    name: '최근 생성 레코드 조회',
    description: '생성 시각 기준으로 가장 최근 행을 조회합니다. 최근 등록 데이터 확인에 사용합니다.',
    roles: ['soft_delete'],
    params: [
      { name: 'table', label: '테이블', kind: 'identifier', identifierKind: 'table', required: true },
      { name: 'createdColumn', label: '생성시각 컬럼', kind: 'identifier', identifierKind: 'column', required: true },
      { name: 'limit', label: '행 수', kind: 'value', valueType: 'number', required: true, default: '50' },
    ],
    sql: `SELECT *
FROM {{table}}
[[WHERE {{role:soft_delete}} IS NULL]]
ORDER BY {{createdColumn}} DESC
LIMIT :limit`,
  },
  {
    id: 'recent-since', source: 'builtin', category: '개발 QA',
    name: '특정 시점 이후 생성 조회',
    description: '입력한 날짜 이후에 생성된 행을 조회합니다. 최근 생성 계정/배포 이후 데이터 확인에 사용합니다.',
    roles: ['soft_delete'],
    params: [
      { name: 'table', label: '테이블', kind: 'identifier', identifierKind: 'table', required: true },
      { name: 'createdColumn', label: '생성시각 컬럼', kind: 'identifier', identifierKind: 'column', required: true },
      { name: 'since', label: '이 날짜 이후', kind: 'value', valueType: 'date', required: true },
    ],
    sql: `SELECT *
FROM {{table}}
WHERE {{createdColumn}} >= :since
[[  AND {{role:soft_delete}} IS NULL]]
ORDER BY {{createdColumn}} DESC
LIMIT 500`,
  },
  {
    id: 'distinct-dist', source: 'builtin', category: '개발 QA',
    name: '컬럼 distinct 값 분포',
    description: '특정 컬럼의 값별 행 수 분포를 봅니다. enum/상태 컬럼 값 분포, 마이그레이션 반영 여부 확인에 사용합니다.',
    roles: ['soft_delete'],
    params: [
      { name: 'table', label: '테이블', kind: 'identifier', identifierKind: 'table', required: true },
      { name: 'column', label: '컬럼', kind: 'identifier', identifierKind: 'column', required: true },
      { name: 'limit', label: '상위 N개', kind: 'value', valueType: 'number', required: true, default: '50' },
    ],
    sql: `SELECT {{column}}, COUNT(*) AS cnt
FROM {{table}}
[[WHERE {{role:soft_delete}} IS NULL]]
GROUP BY {{column}}
ORDER BY cnt DESC
LIMIT :limit`,
  },
];
