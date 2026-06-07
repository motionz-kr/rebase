import { useMemo, useState } from 'react';
import type { TemplateParam } from '../lib/templateTypes';

function scanParams(sql: string): TemplateParam[] {
  const out: TemplateParam[] = [];
  const seen = new Set<string>();
  const noRoles = sql.replace(/\{\{role:(\w+)\}\}/g, '');
  for (const m of noRoles.matchAll(/\{\{(\w+)\}\}/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push({ name: m[1], label: m[1], kind: 'identifier', identifierKind: 'column', required: true });
    }
  }
  for (const m of noRoles.matchAll(/(?<!:):(\w+)/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push({ name: m[1], label: m[1], kind: 'value', valueType: 'string', required: true });
    }
  }
  return out;
}

interface Props {
  initialSql?: string;
  onClose: () => void;
  onSaved: () => void;
}

export function SaveTemplateDialog({ initialSql = '', onClose, onSaved }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('내 템플릿');
  const [sql, setSql] = useState(initialSql);
  const params = useMemo(() => scanParams(sql), [sql]);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim() || !sql.trim()) return;
    setSaving(true);
    await window.electronAPI.saveTemplate({
      id: '',
      workspaceId: 'default',
      name,
      description,
      category,
      sqlText: sql,
      parameters: JSON.stringify(params),
      driver: '',
    });
    setSaving(false);
    onSaved();
    onClose();
  }

  return (
    <div className="risk-dialog-backdrop" role="dialog" aria-modal="true">
      <div className="risk-dialog">
        <header className="risk-header"><span className="risk-verb">새 템플릿 저장</span></header>
        <section className="risk-body">
          <div className="form-field"><label>이름 *</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="form-field"><label>설명</label><input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="form-field"><label>카테고리</label><input value={category} onChange={(e) => setCategory(e.target.value)} /></div>
          <div className="form-field">
            <label>SQL (:값, {'{{컬럼}}'} 자리표시자)</label>
            <textarea rows={6} value={sql} onChange={(e) => setSql(e.target.value)} />
          </div>
          {params.length > 0 && <p className="dialog-hint">감지된 파라미터: {params.map((p) => p.name).join(', ')}</p>}
        </section>
        <footer className="risk-footer">
          <div className="risk-actions">
            <button onClick={onClose}>취소</button>
            <button className="btn btn-primary" disabled={!name.trim() || !sql.trim() || saving} onClick={save}>저장</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
