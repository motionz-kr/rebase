import { useEffect, useMemo, useState } from 'react';
import { BUILTIN_TEMPLATES } from '../lib/builtinTemplates';
import type { TemplateDef, TemplateParam } from '../lib/templateTypes';

interface Props {
  onSelectTemplate: (t: TemplateDef) => void;
  onOpenDomainSettings: () => void;
  onNewTemplate: () => void;
  reloadKey?: number;
}

export function TemplatesPanel({ onSelectTemplate, onOpenDomainSettings, onNewTemplate, reloadKey }: Props) {
  const [user, setUser] = useState<TemplateDef[]>([]);
  const [q, setQ] = useState('');

  useEffect(() => {
    let alive = true;
    window.electronAPI.listTemplates('default').then((res) => {
      if (!alive || !res.success || !res.data) return;
      setUser(
        res.data.map((u) => {
          let params: TemplateParam[] = [];
          try {
            params = JSON.parse(u.parameters || '[]');
          } catch {
            params = [];
          }
          return {
            id: u.id,
            name: u.name,
            description: u.description,
            category: u.category || '내 템플릿',
            sql: u.sqlText,
            params,
            roles: [],
            driver: u.driver,
            source: 'user',
          } as TemplateDef;
        }),
      );
    });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const all = useMemo(() => [...BUILTIN_TEMPLATES, ...user], [user]);
  const filtered = useMemo(
    () => all.filter((t) => (t.name + t.description).toLowerCase().includes(q.toLowerCase())),
    [all, q],
  );
  const byCat = useMemo(() => {
    const m = new Map<string, TemplateDef[]>();
    for (const t of filtered) {
      const a = m.get(t.category) ?? [];
      a.push(t);
      m.set(t.category, a);
    }
    return [...m.entries()];
  }, [filtered]);

  return (
    <div className="templates-panel">
      <div className="templates-toolbar">
        <input className="input" placeholder="템플릿 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-sm" onClick={onOpenDomainSettings}>도메인 설정</button>
        <button className="btn btn-sm" onClick={onNewTemplate}>+ 새 템플릿</button>
      </div>
      {byCat.map(([cat, items]) => (
        <div key={cat} className="templates-cat">
          <div className="templates-cat-head">{cat}</div>
          {items.map((t) => (
            <button key={t.id} className="template-item" onClick={() => onSelectTemplate(t)} title={t.description}>
              <span className="template-item-name">{t.name}</span>
              <span className="template-item-desc">{t.description}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
