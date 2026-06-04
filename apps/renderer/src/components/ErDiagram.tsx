import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useReactFlow,
  getNodesBounds,
  getViewportForBounds,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Search, Maximize2, Loader2, Download } from 'lucide-react';
import { buildErGraph, layoutErGraph, filterErGraph, relatedIds } from '../lib/erGraph';
import { toMermaid, toDbml, joinDdl, type DdlPart } from '../lib/erExport';
import { exportErImage, downloadDataUrl } from '../lib/erImage';
import { download, tsTimestamp } from '../lib/gridFormat';
import type { SchemaGraph, SchemaGraphColumn } from '../global';

interface Props {
  profileId: string;
  database: string;
  onOpenTable?: (table: string) => void;
}

type TableNodeData = { name: string; columns: SchemaGraphColumn[]; dimmed?: boolean };
type TableNodeType = Node<TableNodeData, 'table'>;

function TableNode({ data }: NodeProps<TableNodeType>) {
  return (
    <div className={`er-node${data.dimmed ? ' er-node-dim' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="er-node-head">{data.name}</div>
      <div className="er-node-cols">
        {data.columns.map((c) => (
          <div className="er-col" key={c.name}>
            <span className="er-col-key">{c.primaryKey ? '🔑' : ''}</span>
            <span className="er-col-name">{c.name}</span>
            <span className="er-col-type">{c.type}</span>
          </div>
        ))}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { table: TableNode };
const LARGE = 60;

const ErDiagramInner: React.FC<Props> = ({ profileId, database, onOpenTable }) => {
  const [raw, setRaw] = useState<SchemaGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { fitView } = useReactFlow();

  const load = useCallback(() => {
    setError(null);
    setRaw(null);
    void window.electronAPI.getSchemaGraph(profileId, database).then((res) => {
      if (res.success && res.data) setRaw(res.data);
      else setError(res.error || 'Failed to load schema');
    });
  }, [profileId, database]);
  // Fetch the schema graph on mount / when the target connection changes;
  // resetting to a loading state here is intentional.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(load, [load]);

  const tooLarge = !!raw && raw.tables.length > LARGE && !search.trim();

  const view = useMemo<{ nodes: TableNodeType[]; edges: Edge[] }>(() => {
    if (!raw || tooLarge) return { nodes: [], edges: [] };
    const filtered = filterErGraph(raw, search);
    const laid = layoutErGraph(buildErGraph(filtered));
    const rel = selected ? relatedIds(filtered, selected) : null;
    const nodes: TableNodeType[] = laid.nodes.map((n) => ({
      id: n.id,
      type: 'table',
      position: n.position,
      data: { name: n.data.name, columns: n.data.columns, dimmed: rel ? !rel.tables.has(n.id) : false },
    }));
    const edges: Edge[] = laid.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'smoothstep',
      className: rel ? (rel.edges.has(e.id) ? 'er-edge-hl' : 'er-edge-dim') : undefined,
    }));
    return { nodes, edges };
  }, [raw, search, selected, tooLarge]);

  useEffect(() => {
    if (view.nodes.length) {
      const t = setTimeout(() => fitView({ duration: 200 }), 60);
      return () => clearTimeout(t);
    }
  }, [view.nodes.length, fitView]);

  const onExport = useCallback(
    async (kind: 'png' | 'svg' | 'sql' | 'mermaid' | 'dbml') => {
      setMenuOpen(false);
      setExportErr(null);
      if (!raw) return;
      const g = filterErGraph(raw, search);
      const base = `${database}-er-${tsTimestamp()}`;
      if (kind === 'mermaid') return download(`${base}.mmd`, toMermaid(g), 'text/plain');
      if (kind === 'dbml') return download(`${base}.dbml`, toDbml(g), 'text/plain');
      if (kind === 'sql') {
        const parts: DdlPart[] = [];
        for (const t of g.tables) {
          const res = await window.electronAPI.getTableDDL(profileId, database, t.name);
          if (res.success && res.data) parts.push({ table: t.name, ddl: res.data.ddl });
          else parts.push({ table: t.name, error: res.error || 'unknown error' });
        }
        return download(`${base}.sql`, joinDdl(parts), 'text/plain');
      }
      try {
        // Clear any selection dim/highlight so the exported image is clean, and
        // let React paint the change before snapshotting.
        if (selected) {
          setSelected(null);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))));
        }
        const vpEl = wrapRef.current?.querySelector('.react-flow__viewport') as HTMLElement | null;
        if (!vpEl) throw new Error('viewport not found');
        const bounds = getNodesBounds(view.nodes);
        const w = Math.min(Math.max(Math.round(bounds.width + 120), 640), 4096);
        const h = Math.min(Math.max(Math.round(bounds.height + 120), 480), 4096);
        const vp = getViewportForBounds(bounds, w, h, 0.2, 2, 0.1);
        const transform = `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})`;
        const dataUrl = await exportErImage(kind, vpEl, { width: w, height: h, transform });
        downloadDataUrl(`${base}.${kind}`, dataUrl);
      } catch (e) {
        setExportErr(`이미지 내보내기 실패: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [raw, search, database, profileId, view.nodes, selected],
  );

  if (error) {
    return (
      <div className="er-state">
        <p>{error}</p>
        <button className="btn btn-secondary btn-sm" onClick={load}>
          다시 시도
        </button>
      </div>
    );
  }
  if (!raw) {
    return (
      <div className="er-state">
        <Loader2 size={16} className="spin" /> 스키마 불러오는 중…
      </div>
    );
  }
  if (raw.tables.length === 0) {
    return <div className="er-state">이 데이터베이스에 테이블이 없습니다.</div>;
  }

  return (
    <div className="er-wrap" ref={wrapRef}>
      <div className="er-toolbar">
        <div className="er-search">
          <Search size={13} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="테이블/컬럼 검색…" />
        </div>
        <span className="er-count">{raw.tables.length} tables</span>
        <button className="btn btn-secondary btn-xs" onClick={() => fitView({ duration: 200 })}>
          <Maximize2 size={12} /> 맞춤
        </button>
        <div className="er-export">
          <button className="btn btn-secondary btn-xs" onClick={() => setMenuOpen((v) => !v)}>
            <Download size={12} /> 내보내기 ▾
          </button>
          {menuOpen && (
            <div className="er-export-menu" onMouseLeave={() => setMenuOpen(false)}>
              <button onClick={() => onExport('png')} disabled={tooLarge}>
                PNG 이미지
              </button>
              <button onClick={() => onExport('svg')} disabled={tooLarge}>
                SVG 이미지
              </button>
              <button onClick={() => onExport('sql')}>SQL (DDL)</button>
              <button onClick={() => onExport('mermaid')}>Mermaid</button>
              <button onClick={() => onExport('dbml')}>DBML</button>
            </div>
          )}
        </div>
        {exportErr && <span className="er-export-err">{exportErr}</span>}
      </div>
      {tooLarge ? (
        <div className="er-state">{raw.tables.length}개 테이블 — 검색으로 좁혀보세요.</div>
      ) : (
        <ReactFlow
          nodes={view.nodes}
          edges={view.edges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.1}
          nodesDraggable={false}
          onNodeClick={(_, n) => setSelected(n.id)}
          onNodeDoubleClick={(_, n) => onOpenTable?.(n.id)}
          onPaneClick={() => setSelected(null)}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      )}
    </div>
  );
};

export const ErDiagram: React.FC<Props> = (props) => (
  <ReactFlowProvider>
    <ErDiagramInner {...props} />
  </ReactFlowProvider>
);
