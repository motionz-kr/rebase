import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useReactFlow,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Search, Maximize2, Loader2 } from 'lucide-react';
import { buildErGraph, layoutErGraph, filterErGraph, relatedIds } from '../lib/erGraph';
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
    <div className="er-wrap">
      <div className="er-toolbar">
        <div className="er-search">
          <Search size={13} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="테이블/컬럼 검색…" />
        </div>
        <span className="er-count">{raw.tables.length} tables</span>
        <button className="btn btn-secondary btn-xs" onClick={() => fitView({ duration: 200 })}>
          <Maximize2 size={12} /> 맞춤
        </button>
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
