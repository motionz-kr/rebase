import { useEffect, useMemo, useRef, useState } from 'react';
import type { DomainEntry } from '../lib/domainGlossary';
import { mergeSchema, parseGlossary, serializeGlossary } from '../lib/domainGlossary';
import { buildFillPrompt, parseFillResponse } from '../lib/domainFillPrompt';
import { loadAgentSettings, isOAuthProvider } from '../lib/agentSettings';

interface Props {
  profileId: string;
  glossaryJson?: string;
  notes?: string;
  tables: string[];
  columnsByTable: Record<string, string[]>;
  onChange: (glossaryJson: string, notes: string) => void;
}

export function DomainDictionaryEditor({ profileId, glossaryJson, notes, tables, columnsByTable, onChange }: Props) {
  const [entries, setEntries] = useState<DomainEntry[]>(() =>
    mergeSchema(parseGlossary(glossaryJson), tables, columnsByTable),
  );
  const [noteText, setNoteText] = useState(notes ?? '');
  const [filter, setFilter] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiHint, setAiHint] = useState('');
  const offRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { offRef.current?.(); }, []);

  // always hold the latest onChange without making it a dep of the bubble effect
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });

  // re-seed if the schema arrives after mount
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEntries((cur) => mergeSchema(cur, tables, columnsByTable));
  }, [tables, columnsByTable]);

  // bubble changes upward — depends only on data, not on onChange identity
  useEffect(() => { onChangeRef.current(serializeGlossary(entries), noteText); }, [entries, noteText]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) => e.table.toLowerCase().includes(q) || e.column.toLowerCase().includes(q) || e.meaning.toLowerCase().includes(q),
    );
  }, [entries, filter]);

  function setMeaning(target: DomainEntry, meaning: string) {
    setEntries((cur) => cur.map((e) => (e.table === target.table && e.column === target.column && e.kind === target.kind ? { ...e, meaning } : e)));
  }

  function applyProposals(props: DomainEntry[]) {
    if (props.length === 0) return;
    const pk = (e: DomainEntry) => `${e.kind} ${e.table} ${e.column}`;
    const map = new Map(props.map((p) => [pk(p), p.meaning]));
    setEntries((cur) => cur.map((e) => (e.meaning.trim() === '' && map.has(pk(e)) ? { ...e, meaning: map.get(pk(e))! } : e)));
  }

  async function aiFill() {
    const s = loadAgentSettings();
    const p = s.provider;
    const status = isOAuthProvider(p)
      ? await window.electronAPI.agentOAuthStatus(p === 'openai-oauth' ? 'openai' : 'anthropic')
      : await window.electronAPI.agentKeyStatus(p);
    const data = status?.data as Record<string, unknown> | undefined;
    const ready = !!(status?.success && (data?.['present'] || data?.['loggedIn']));
    if (!ready) {
      setAiHint('AI 미설정 — 어시스턴트에서 provider/키를 설정하세요.');
      return;
    }
    setAiBusy(true); setAiHint('');
    const { system, user } = buildFillPrompt(tables, columnsByTable);
    const runId = `domfill-${profileId}`;
    let acc = '';
    offRef.current?.();
    const off = window.electronAPI.onAgentStreamChunk((rid, chunk) => {
      if (rid !== runId) return;
      if (chunk.kind === 'text') { acc += chunk.text ?? ''; }
      else if (chunk.kind === 'error') { setAiHint(`AI 오류: ${chunk.err ?? ''}`); setAiBusy(false); off(); offRef.current = null; }
      else if (chunk.kind === 'done') { applyProposals(parseFillResponse(acc)); setAiBusy(false); off(); offRef.current = null; }
    });
    offRef.current = off;
    const res = await window.electronAPI.generateNarration(runId, profileId, system, [{ role: 'user', text: user }], { provider: s.provider, model: s.model });
    if (!res.success) { setAiHint(res.error ?? 'AI 호출 실패'); setAiBusy(false); off(); offRef.current = null; }
  }

  const byTable = useMemo(() => {
    const m: Record<string, DomainEntry[]> = {};
    for (const e of filtered) (m[e.table] ??= []).push(e);
    return m;
  }, [filtered]);

  return (
    <div className="domain-dict">
      <div className="domain-dict-toolbar">
        <input className="domain-dict-search" placeholder="테이블·컬럼·의미 검색" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button className="btn btn-sm" onClick={aiFill} disabled={aiBusy}>{aiBusy ? 'AI 채우는 중…' : 'AI로 채우기'}</button>
      </div>
      {aiHint && <p className="domain-dict-hint">{aiHint}</p>}
      <div className="domain-dict-grid">
        {Object.keys(byTable).map((t) => (
          <div key={t} className="domain-dict-table">
            {byTable[t].map((e) => (
              <div key={`${e.kind}-${e.table}-${e.column}`} className={`domain-dict-row${e.kind === 'table' ? ' is-table' : ''}`}>
                <span className="domain-dict-name">{e.kind === 'table' ? e.table : `· ${e.column}`}</span>
                <input className="domain-dict-meaning" placeholder="업무 의미" value={e.meaning} onChange={(ev) => setMeaning(e, ev.target.value)} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <label className="domain-dict-notes-label">도메인 규칙 (자유 서술)</label>
      <textarea className="domain-dict-notes" rows={4} placeholder={'예: 항상 deletedAt IS NULL\nhospitalId로 범위 제한'} value={noteText} onChange={(e) => setNoteText(e.target.value)} />
    </div>
  );
}
