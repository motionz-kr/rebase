import { useCallback, useState } from 'react';
import { suggestBindings } from '../lib/suggestBindings';
import type { ConnectionProfile } from '../global';
import { DomainDictionaryEditor } from './DomainDictionaryEditor';

const ROLES: { key: string; label: string; hint: string }[] = [
  { key: 'tenant', label: 'Tenant 컬럼', hint: '병원/조직 구분 컬럼 (예: hospitalId)' },
  { key: 'soft_delete', label: 'Soft-delete 컬럼', hint: '삭제 표시 컬럼 (예: deletedAt)' },
];

interface Props {
  profile: ConnectionProfile;
  columns: string[];            // distinct column names across the connection's tables
  tables: string[];
  columnsByTable: Record<string, string[]>;
  onClose: () => void;
  onSaved: () => void;
}

export function DomainBindingsDialog({ profile, columns, tables, columnsByTable, onClose, onSaved }: Props) {
  // Compute the initial bindings once on mount (the dialog is re-mounted each
  // time it opens, and columns are already loaded by the Templates tab).
  const [bindings, setBindings] = useState<Record<string, string>>(() => {
    let existing: Record<string, string>;
    try {
      existing = profile.domainBindings ? JSON.parse(profile.domainBindings) : {};
    } catch {
      existing = {};
    }
    const tenantCols = (profile.tenantColumns ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const suggested = suggestBindings(columns, tenantCols);
    return { ...suggested, ...existing }; // existing wins over suggestion
  });
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'roles' | 'glossary'>('roles');
  const [glossary, setGlossary] = useState(profile.domainGlossary ?? '');
  const [notes, setNotes] = useState(profile.domainNotes ?? '');

  const handleDictChange = useCallback((g: string, n: string) => {
    setGlossary(g);
    setNotes(n);
  }, []);

  async function save() {
    setSaving(true);
    const cleaned = Object.fromEntries(Object.entries(bindings).filter(([, v]) => v));
    await window.electronAPI.updateProfile({ ...profile, domainBindings: JSON.stringify(cleaned), domainGlossary: glossary, domainNotes: notes });
    setSaving(false);
    onSaved();
    onClose();
  }

  return (
    <div className="risk-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="risk-dialog">
        <header className="risk-header">
          <span className="risk-verb">도메인 설정 · {profile.name}</span>
        </header>
        <div className="domain-tabs">
          <button className={`domain-tab${tab === 'roles' ? ' active' : ''}`} onClick={() => setTab('roles')}>역할 바인딩</button>
          <button className={`domain-tab${tab === 'glossary' ? ' active' : ''}`} onClick={() => setTab('glossary')}>용어사전·규칙</button>
        </div>
        <section className="risk-body">
          {tab === 'roles' ? (
            <>
              <p className="risk-note">의미 역할을 실제 컬럼에 매핑하면 템플릿이 자동으로 사용합니다. (스키마에서 자동 추천됨)</p>
              {ROLES.map((r) => (
                <div key={r.key} className="form-field">
                  <label>{r.label}</label>
                  <select
                    value={bindings[r.key] ?? ''}
                    onChange={(e) => setBindings((b) => ({ ...b, [r.key]: e.target.value }))}
                  >
                    <option value="">(미설정)</option>
                    {columns.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <span className="dialog-hint">{r.hint}</span>
                </div>
              ))}
            </>
          ) : (
            <DomainDictionaryEditor
              profileId={profile.id!}
              glossaryJson={profile.domainGlossary}
              notes={profile.domainNotes}
              tables={tables}
              columnsByTable={columnsByTable}
              onChange={handleDictChange}
            />
          )}
        </section>
        <footer className="risk-footer">
          <div className="risk-actions">
            <button className="btn btn-secondary" onClick={onClose}>취소</button>
            <button className="btn btn-primary" disabled={saving} onClick={save}>저장</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
