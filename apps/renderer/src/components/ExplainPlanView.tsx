import React, { useState } from 'react';
import { ChevronDown, ChevronRight, ListTree } from 'lucide-react';
import { ResultGrid } from './ResultGrid';
import { parseExplainPlan, type ExplainDriver, type ExplainPlanNode } from '../lib/explainPlan';

interface Props {
  driver: ExplainDriver;
  columns: string[];
  rows: unknown[][];
}

export const ExplainPlanView: React.FC<Props> = ({ driver, columns, rows }) => {
  const plan = parseExplainPlan(driver, columns, rows);
  const [view, setView] = useState<'plan' | 'raw'>(plan ? 'plan' : 'raw');

  return (
    <section className="explain-plan" aria-label="Query execution plan">
      <div className="explain-plan-toolbar">
        <div className="explain-plan-heading">
          <ListTree size={15} />
          <span>Execution plan</span>
          {plan && <span className="explain-plan-format">{plan.format}</span>}
        </div>
        <div className="explain-plan-views" role="group" aria-label="Plan result view">
          <button type="button" className={view === 'plan' ? 'active' : ''} disabled={!plan} onClick={() => setView('plan')}>
            Plan
          </button>
          <button type="button" className={view === 'raw' ? 'active' : ''} onClick={() => setView('raw')}>
            Raw result
          </button>
        </div>
      </div>
      {view === 'plan' && plan ? (
        <div className="explain-plan-tree" role="tree">
          {plan.roots.map((node, index) => <PlanNode key={`${node.operation}-${index}`} node={node} level={0} />)}
        </div>
      ) : (
        <>
          {!plan && (
            <div className="explain-plan-fallback">
              This driver or result format does not have a visual plan view. Showing the original EXPLAIN result.
            </div>
          )}
          <ResultGrid columns={columns} rows={rows} />
        </>
      )}
    </section>
  );
};

const PlanNode: React.FC<{ node: ExplainPlanNode; level: number }> = ({ node, level }) => {
  const [collapsed, setCollapsed] = useState(false);
  const hasChildren = node.children.length > 0;

  return (
    <div className="explain-plan-node" role="treeitem" aria-expanded={hasChildren ? !collapsed : undefined}>
      <div className="explain-plan-row" style={{ paddingLeft: level * 20 }}>
        {hasChildren ? (
          <button
            type="button"
            className="explain-plan-toggle"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${node.operation}`}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
        ) : <span className="explain-plan-toggle-placeholder" />}
        <span className="explain-plan-operation">{node.operation}</span>
        {node.details.map((detail, index) => <span className="explain-plan-detail" key={`${detail}-${index}`}>{detail}</span>)}
      </div>
      {hasChildren && !collapsed && (
        <div role="group">
          {node.children.map((child, index) => <PlanNode key={`${child.operation}-${index}`} node={child} level={level + 1} />)}
        </div>
      )}
    </div>
  );
};
