import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Clipboard, Loader2, RefreshCw } from 'lucide-react';
import type { ConnectionProfile, SchemaGraph } from '../global';
import { compareSchemaGraphs, generateAdditiveMigration, type SchemaDifference, type SchemaDifferenceKind } from '../lib/schemaCompare';
import type { Driver } from '../lib/ddlBuilder';

type CompareDriver = 'mysql' | 'postgres' | 'sqlite';

interface Props {
  sourceProfileId: string;
  sourceDatabase: string;
  driver: CompareDriver;
  profiles: ConnectionProfile[];
  onClose: () => void;
}

const KIND_LABEL: Record<SchemaDifferenceKind, string> = {
  'table-missing': '대상에 테이블 추가',
  'table-extra': '대상에만 있는 테이블',
  'column-missing': '대상에 컬럼 추가',
  'column-extra': '대상에만 있는 컬럼',
  'column-changed': '컬럼 정의 차이',
  'index-missing': '대상에 인덱스 추가',
  'index-extra': '대상에만 있는 인덱스',
  'foreign-key-missing': '대상에 외래 키 추가 필요',
  'foreign-key-extra': '대상에만 있는 외래 키',
};

export const SchemaCompareDialog: React.FC<Props> = ({ sourceProfileId, sourceDatabase, driver, profiles, onClose }) => {
  const compatibleProfiles = useMemo(
    () => profiles.filter((profile) => profile.id && profile.driver === driver),
    [profiles, driver],
  );
  const sourceProfile = compatibleProfiles.find((profile) => profile.id === sourceProfileId);
  const firstTarget = compatibleProfiles.find((profile) => profile.id !== sourceProfileId) ?? sourceProfile;
  const [targetProfileId, setTargetProfileId] = useState(firstTarget?.id ?? '');
  const [targetDatabases, setTargetDatabases] = useState<string[]>([]);
  const [targetDatabase, setTargetDatabase] = useState('');
  const [loadingDatabases, setLoadingDatabases] = useState(!!firstTarget?.id);
  const [loadingCompare, setLoadingCompare] = useState(false);
  const [loadingDraft, setLoadingDraft] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comparison, setComparison] = useState<{ source: SchemaGraph; target: SchemaGraph; differences: SchemaDifference[] } | null>(null);
  const [migrationSql, setMigrationSql] = useState('');
  const [manualItems, setManualItems] = useState<SchemaDifference[]>([]);
  const [draftStatus, setDraftStatus] = useState('');

  const targetProfile = compatibleProfiles.find((profile) => profile.id === targetProfileId);
  const samePair = targetProfileId === sourceProfileId && targetDatabase === sourceDatabase;

  useEffect(() => {
    if (!targetProfileId) return;
    let ignore = false;
    void window.electronAPI.listDatabases(targetProfileId).then((res) => {
      if (ignore) return;
      if (!res.success || !res.data) {
        setError(res.error || '대상 데이터베이스 목록을 불러오지 못했습니다.');
        return;
      }
      const names = res.data.map((database) => database.name);
      setTargetDatabases(names);
      const profileDatabase = targetProfile?.database;
      const preferred = names.includes(profileDatabase ?? '')
        ? profileDatabase
        : targetProfileId === sourceProfileId
          ? names.find((name) => name !== sourceDatabase)
          : names[0];
      setTargetDatabase(preferred ?? names[0] ?? '');
    }).catch((cause: unknown) => {
      if (!ignore) setError(cause instanceof Error ? cause.message : '대상 데이터베이스 목록을 불러오지 못했습니다.');
    }).finally(() => {
      if (!ignore) setLoadingDatabases(false);
    });
    return () => { ignore = true; };
  }, [targetProfileId, targetProfile?.database, sourceProfileId, sourceDatabase]);

  const changeTargetProfile = (profileId: string) => {
    if (profileId === targetProfileId) return;
    setTargetProfileId(profileId);
    setLoadingDatabases(true);
    setTargetDatabases([]);
    setTargetDatabase('');
    setComparison(null);
    setMigrationSql('');
    setManualItems([]);
    setError(null);
  };

  const changeTargetDatabase = (database: string) => {
    setTargetDatabase(database);
    setComparison(null);
    setMigrationSql('');
    setManualItems([]);
    setError(null);
  };

  const compare = async () => {
    if (!targetProfileId || !targetDatabase || samePair) return;
    setLoadingCompare(true);
    setError(null);
    setComparison(null);
    setMigrationSql('');
    setManualItems([]);
    setDraftStatus('');
    try {
      const [sourceResult, targetResult] = await Promise.all([
        window.electronAPI.getSchemaGraph(sourceProfileId, sourceDatabase),
        window.electronAPI.getSchemaGraph(targetProfileId, targetDatabase),
      ]);
      if (!sourceResult.success || !sourceResult.data) throw new Error(`Source: ${sourceResult.error || '스키마를 불러오지 못했습니다.'}`);
      if (!targetResult.success || !targetResult.data) throw new Error(`Target: ${targetResult.error || '스키마를 불러오지 못했습니다.'}`);
      setComparison({
        source: sourceResult.data,
        target: targetResult.data,
        differences: compareSchemaGraphs(sourceResult.data, targetResult.data),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingCompare(false);
    }
  };

  const createDraft = async () => {
    if (!comparison) return;
    setLoadingDraft(true);
    setDraftStatus('');
    try {
      const missingTables = comparison.differences.filter((difference) => difference.kind === 'table-missing');
      const ddlEntries = await Promise.all(missingTables.map(async (difference) => {
        const res = await window.electronAPI.getTableDDL(sourceProfileId, sourceDatabase, difference.table);
        return [difference.table, res.success ? res.data?.ddl ?? '' : ''] as const;
      }));
      const ddlByTable = Object.fromEntries(ddlEntries);
      const result = generateAdditiveMigration(driver as Driver, comparison.differences, ddlByTable);
      setMigrationSql(result.statements.length ? `${result.statements.join(';\n\n')};` : '');
      setManualItems(result.manual);
      setDraftStatus(result.statements.length ? `${result.statements.length}개 추가 변경 SQL 초안이 생성되었습니다. 실행 전 검토하세요.` : '자동 생성 가능한 안전한 추가 변경이 없습니다. 아래 차이를 수동 검토하세요.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingDraft(false);
    }
  };

  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(migrationSql);
      setDraftStatus('SQL을 클립보드에 복사했습니다. 데이터베이스에는 실행하지 않았습니다.');
    } catch {
      setDraftStatus('복사하지 못했습니다. SQL을 선택해 직접 복사하세요.');
    }
  };

  const automaticCount = comparison?.differences.filter((difference) => {
    if (difference.kind === 'table-missing') return true;
    if (difference.kind === 'index-missing') return !!difference.sourceIndex && !difference.sourceIndex.partial && !difference.sourceIndex.prefix && difference.sourceIndex.columns.length > 0;
    if (difference.kind !== 'column-missing') return false;
    const column = difference.sourceColumn;
    return !!column && !column.primaryKey && !!column.type.trim() && (column.nullable || !!column.defaultValue?.trim());
  }).length ?? 0;

  return (
    <div className="modal-overlay schema-compare-overlay" onClick={onClose}>
      <div className="modal modal-wide schema-compare-modal" role="dialog" aria-modal="true" aria-labelledby="schema-compare-title" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h3 id="schema-compare-title">스키마 비교</h3>
          <button className="icon-btn" onClick={onClose} title="닫기">×</button>
        </div>

        <div className="schema-compare-pair">
          <div className="schema-compare-side">
            <label>Source · 기준</label>
            <div className="schema-compare-source">{sourceProfile?.name ?? sourceProfileId} / <span className="mono">{sourceDatabase}</span></div>
          </div>
          <span className="schema-compare-arrow">→</span>
          <div className="schema-compare-side">
            <label htmlFor="schema-compare-profile">Target · 비교 대상</label>
            <select id="schema-compare-profile" className="input" value={targetProfileId} onChange={(event) => changeTargetProfile(event.target.value)} disabled={loadingCompare || loadingDraft}>
              {compatibleProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
            <select aria-label="Target database" className="input" value={targetDatabase} onChange={(event) => changeTargetDatabase(event.target.value)} disabled={loadingDatabases || loadingCompare || loadingDraft || targetDatabases.length === 0}>
              {targetDatabases.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
          <button className="btn btn-primary btn-sm schema-compare-run" onClick={() => void compare()} disabled={!targetProfileId || !targetDatabase || samePair || loadingDatabases || loadingCompare}>
            {loadingCompare ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            비교
          </button>
        </div>

        <div className="schema-compare-body">
          {loadingDatabases && <div className="schema-compare-empty"><Loader2 size={15} className="spin" /> 대상 데이터베이스 확인 중…</div>}
          {!loadingDatabases && compatibleProfiles.length === 0 && <div className="schema-compare-empty">같은 종류({driver})의 연결 프로필이 없습니다.</div>}
          {!loadingDatabases && targetDatabases.length === 0 && targetProfile && !error && <div className="schema-compare-empty">대상 프로필에서 비교 가능한 데이터베이스를 찾지 못했습니다.</div>}
          {samePair && <div className="schema-compare-empty">Source와 Target을 서로 다른 데이터베이스로 선택하세요.</div>}
          {loadingCompare && <div className="schema-compare-empty"><Loader2 size={15} className="spin" /> 두 스키마를 읽고 비교 중…</div>}
          {error && <div className="alert error"><AlertTriangle size={14} />{error}</div>}
          {comparison && !loadingCompare && (
            <>
              <div className="schema-compare-summary">
                {comparison.differences.length === 0
                  ? '스키마가 같습니다.'
                  : `${comparison.differences.length}개 차이 · 최대 ${automaticCount}개 변경을 SQL 초안으로 만들 수 있습니다.`}
              </div>
              {comparison.differences.length === 0 ? (
                <div className="schema-compare-empty"><Check size={15} /> 비교 결과 차이가 없습니다.</div>
              ) : (
                <div className="schema-compare-diffs" role="table" aria-label="Schema differences">
                  {comparison.differences.map((difference, index) => (
                    <DifferenceRow key={`${difference.kind}:${difference.table}:${difference.object}:${index}`} difference={difference} />
                  ))}
                </div>
              )}
              <div className="schema-compare-actions">
                <span>초안은 여기서 실행되지 않습니다.</span>
                <button className="btn btn-secondary btn-sm" onClick={() => void createDraft()} disabled={loadingDraft || comparison.differences.length === 0}>
                  {loadingDraft ? <Loader2 size={13} className="spin" /> : <Clipboard size={13} />}
                  SQL 초안 생성
                </button>
              </div>
              {draftStatus && <div className="schema-compare-draft-status">{draftStatus}</div>}
              {manualItems.length > 0 && (
                <div className="schema-compare-manual">
                  <strong>수동 검토 필요 ({manualItems.length})</strong>
                  <ul>{manualItems.map((item, index) => <li key={`${item.kind}:${item.table}:${item.object}:${index}`}>{KIND_LABEL[item.kind]} · {item.table}.{item.object}: {item.detail}</li>)}</ul>
                </div>
              )}
              {migrationSql && (
                <div className="schema-compare-sql-wrap">
                  <label htmlFor="schema-compare-sql">검토 및 수정 가능한 SQL 초안</label>
                  <textarea id="schema-compare-sql" aria-label="Migration SQL draft" className="input schema-compare-sql mono" value={migrationSql} onChange={(event) => setMigrationSql(event.target.value)} spellCheck={false} />
                  <div className="schema-compare-sql-note">비파괴 추가 변경만 포함합니다. 자동 적용되지 않습니다.</div>
                  <button className="btn btn-secondary btn-sm" onClick={() => void copyDraft()}><Clipboard size={13} /> SQL 복사</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const DifferenceRow: React.FC<{ difference: SchemaDifference }> = ({ difference }) => (
  <div className={`schema-compare-diff schema-compare-diff-${difference.kind}`} role="row" data-diff-kind={difference.kind}>
    <span className="schema-compare-kind" role="cell">{KIND_LABEL[difference.kind]}</span>
    <span className="schema-compare-object mono" role="cell">{difference.table}.{difference.object}</span>
    <span className="schema-compare-detail" role="cell">{difference.detail}</span>
  </div>
);
