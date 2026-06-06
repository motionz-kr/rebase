import React, { useState, useEffect } from 'react';
import { ChevronRight, Database, Boxes, AlertTriangle, FileText, Terminal, KeyRound, ListTree } from 'lucide-react';

export type MongoMode = 'documents' | 'query' | 'indexes' | 'schema';

interface MongoExplorerProps {
  profileId: string;
  onOpen: (database: string, collection: string, mode: MongoMode) => void;
  onDisconnect: () => void;
}

interface DbNode {
  name: string;
  collections?: string[];
  isOpen: boolean;
  isLoading: boolean;
}

export const MongoExplorer: React.FC<MongoExplorerProps> = ({ profileId, onOpen }) => {
  const [databases, setDatabases] = useState<DbNode[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; db: string; collection: string } | null>(null);

  // Close the context menu on any outside click or Escape.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const loadDatabases = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await window.electronAPI.mongoDatabases(profileId);
      if (res.success && res.data) {
        setDatabases(res.data.data.map((db) => ({ name: db.name, isOpen: false, isLoading: false })));
      } else {
        setError(res.error || '데이터베이스 목록을 불러오지 못했습니다.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '데이터베이스 조회 중 오류');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDatabases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  const toggleDatabase = async (dbName: string) => {
    const target = databases.find((d) => d.name === dbName);
    if (!target) return;
    const nextIsOpen = !target.isOpen;

    if (nextIsOpen && !target.collections) {
      setDatabases((prev) => prev.map((db) => (db.name === dbName ? { ...db, isOpen: true, isLoading: true } : db)));
      let collections: string[] | undefined;
      try {
        const res = await window.electronAPI.mongoCollections(profileId, dbName);
        if (res.success && res.data) collections = res.data.data.map((c) => c.name);
      } catch (err) {
        console.error(err);
      }
      setDatabases((prev) =>
        prev.map((db) =>
          db.name === dbName ? { ...db, isOpen: true, isLoading: false, collections: collections ?? db.collections } : db
        )
      );
      return;
    }

    setDatabases((prev) => prev.map((db) => (db.name === dbName ? { ...db, isOpen: nextIsOpen } : db)));
  };

  const openMenu = (e: React.MouseEvent, db: string, collection: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, db, collection });
  };

  const pick = (mode: MongoMode) => {
    if (!menu) return;
    onOpen(menu.db, menu.collection, mode);
    setMenu(null);
  };

  if (loading) {
    return (
      <div className="load-center">
        <span className="spinner" /> Loading databases…
      </div>
    );
  }

  if (error) {
    return (
      <div className="alert error alert-inline">
        <AlertTriangle size={14} />
        <span>{error}</span>
      </div>
    );
  }

  if (databases.length === 0) {
    return <div className="muted">No databases found.</div>;
  }

  return (
    <>
      <div className="tree">
        {databases.map((db) => (
          <div key={db.name} className="tree-node">
            <div className="tree-row" onClick={() => void toggleDatabase(db.name)}>
              <span className={`tree-chevron ${db.isOpen ? 'open' : ''}`}>
                <ChevronRight size={14} />
              </span>
              <span className="tree-icon">
                <Database size={14} />
              </span>
              <span className="tree-label">{db.name}</span>
              {db.isLoading && <span className="spinner" />}
            </div>

            {db.isOpen && db.collections && (
              <div className="tree-children">
                {db.collections.length === 0 ? (
                  <div className="muted" style={{ padding: '4px 8px' }}>
                    No collections
                  </div>
                ) : (
                  db.collections.map((coll) => (
                    <div key={coll} className="tree-node">
                      <div
                        className="tree-row"
                        onClick={() => onOpen(db.name, coll, 'documents')}
                        onContextMenu={(e) => openMenu(e, db.name, coll)}
                      >
                        <span className="tree-chevron" />
                        <span className="tree-icon">
                          <Boxes size={14} />
                        </span>
                        <span className="tree-label">{coll}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {menu && (
        <div className="ctx-menu" style={{ top: menu.y, left: menu.x }} onClick={(e) => e.stopPropagation()}>
          <button className="ctx-item" onClick={() => pick('documents')}>
            <FileText size={13} /> 문서 보기
          </button>
          <button className="ctx-item" onClick={() => pick('query')}>
            <Terminal size={13} /> 쿼리
          </button>
          <div className="ctx-sep" />
          <button className="ctx-item" onClick={() => pick('indexes')}>
            <KeyRound size={13} /> 인덱스
          </button>
          <button className="ctx-item" onClick={() => pick('schema')}>
            <ListTree size={13} /> 스키마 추론
          </button>
        </div>
      )}
    </>
  );
};
