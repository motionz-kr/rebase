import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Database,
  RefreshCw,
  Search,
  Server,
  X,
} from 'lucide-react';
import type { McpActivityEvent, McpServer, McpWriteProposal } from '../global';

type StatusFilter = 'all' | 'success' | 'error';
type DirectionFilter = 'all' | 'inbound' | 'outbound';

type Props = {
  profiles: Array<{ id?: string; name: string; driver: string }>;
  onClose: () => void;
};

const EVENT_LABEL: Record<string, string> = {
  session_started: '핸드셰이크 시작',
  session_ended: '세션 종료',
  tool_call: '도구 호출',
  test: '연결 테스트',
  connect: '외부 서버 연결',
  write_approval: '쓰기 승인 실행',
};

function eventLabel(event: McpActivityEvent): string {
  return EVENT_LABEL[event.event] ?? event.event;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}s`;
}

export const McpActivityPage: React.FC<Props> = ({ profiles, onClose }) => {
  const [events, setEvents] = useState<McpActivityEvent[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [writeProposals, setWriteProposals] = useState<McpWriteProposal[]>([]);
  const [proposalBusyId, setProposalBusyId] = useState<string | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [direction, setDirection] = useState<DirectionFilter>('all');
  const [target, setTarget] = useState('all');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadedDetailIds, setLoadedDetailIds] = useState<Set<string>>(() => new Set());

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    setLoadError(null);
    try {
      const [activityRes, serversRes, proposalsRes] = await Promise.all([
        window.electronAPI.mcpActivityList({ limit: 100 }),
        window.electronAPI.mcpServersList('default'),
        window.electronAPI.mcpWriteProposalsList(undefined, 'pending_approval'),
      ]);
      if (!activityRes.success) setLoadError(activityRes.error || 'MCP 활동을 불러오지 못했습니다.');
      setEvents(activityRes.data ?? []);
      setServers(serversRes.data ?? []);
      setWriteProposals((proposalsRes.data ?? []).map((proposal) => ({ ...proposal, reasons: proposal.reasons ?? [] })));
      if (!proposalsRes.success && !activityRes.success) setLoadError(proposalsRes.error || activityRes.error || 'MCP 활동을 불러오지 못했습니다.');
      setExpandedId(null);
      setLoadedDetailIds(new Set());
      setDetailError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'MCP 활동을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const actOnProposal = useCallback(async (id: string, action: 'approve' | 'reject') => {
    setProposalBusyId(id);
    setProposalError(null);
    try {
      const result = await window.electronAPI.mcpWriteProposalAction(id, action);
      if (!result.success) {
        setProposalError(result.error || '쓰기 승인 요청을 처리하지 못했습니다.');
        return;
      }
      await load(true);
    } catch (error) {
      setProposalError(error instanceof Error ? error.message : '쓰기 승인 요청을 처리하지 못했습니다.');
    } finally {
      setProposalBusyId(null);
    }
  }, [load]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(initialLoad);
  }, [load]);

  const toggleEvent = useCallback(async (event: McpActivityEvent) => {
    if (expandedId === event.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(event.id);
    setDetailError(null);
    if (loadedDetailIds.has(event.id)) return;

    setLoadingDetailId(event.id);
    try {
      const detailRes = await window.electronAPI.mcpActivityGet(event.id, event.workspaceId || 'default');
      if (!detailRes.success || !detailRes.data) {
        setDetailError(detailRes.error || 'MCP 활동 상세를 불러오지 못했습니다.');
        return;
      }
      setEvents((current) => current.map((item) => item.id === event.id ? { ...item, ...detailRes.data } : item));
      setLoadedDetailIds((current) => new Set(current).add(event.id));
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : 'MCP 활동 상세를 불러오지 못했습니다.');
    } finally {
      setLoadingDetailId((current) => current === event.id ? null : current);
    }
  }, [expandedId, loadedDetailIds]);

  const profileNames = useMemo(() => new Map(profiles.filter((p) => p.id).map((p) => [p.id!, p.name])), [profiles]);
  const serverNames = useMemo(() => new Map(servers.map((server) => [server.id, server.name])), [servers]);

  const targetOptions = useMemo(() => {
    const ids = new Set<string>();
    events.forEach((event) => {
      if (event.profileId) ids.add(`profile:${event.profileId}`);
      if (event.serverId) ids.add(`server:${event.serverId}`);
    });
    return Array.from(ids).map((value) => {
      const [kind, id] = value.split(':');
      return {
        value,
        label: kind === 'profile' ? profileNames.get(id) || `프로필 ${id.slice(0, 8)}` : serverNames.get(id) || `서버 ${id.slice(0, 8)}`,
      };
    }).sort((a, b) => a.label.localeCompare(b.label));
  }, [events, profileNames, serverNames]);

  const targetLabel = useCallback((event: McpActivityEvent): string => {
    if (event.profileId) return profileNames.get(event.profileId) || `프로필 ${event.profileId.slice(0, 8)}`;
    if (event.serverId) return serverNames.get(event.serverId) || `서버 ${event.serverId.slice(0, 8)}`;
    return event.direction === 'inbound' ? '외부 AI 클라이언트' : '외부 MCP 서버';
  }, [profileNames, serverNames]);

  const filteredEvents = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return events.filter((event) => {
      if (status !== 'all' && event.status !== status) return false;
      if (direction !== 'all' && event.direction !== direction) return false;
      if (target !== 'all' && target !== `profile:${event.profileId}` && target !== `server:${event.serverId}`) return false;
      if (!needle) return true;
      return [event.tool, event.event, event.error ?? '', targetLabel(event)].some((value) => value.toLowerCase().includes(needle));
    });
  }, [direction, events, search, status, target, targetLabel]);

  const failureCount = events.filter((event) => event.status === 'error').length;
  const toolCallCount = events.filter((event) => event.event === 'tool_call').length;
  const sessionCount = events.filter((event) => event.event === 'session_started').length;
  const profileLabel = useCallback((profileId: string) => profileNames.get(profileId) || `프로필 ${profileId.slice(0, 8)}`, [profileNames]);

  return (
    <div className="modal-overlay settings-page-overlay mcp-activity-overlay" onClick={onClose}>
      <div className="mcp-activity-page" role="dialog" aria-modal="true" aria-label="MCP 활동" onClick={(event) => event.stopPropagation()}>
        <header className="mcp-activity-head">
          <div className="mcp-activity-title">
            <span className="mcp-activity-title-icon"><Activity size={18} /></span>
            <div>
              <h2>MCP 활동</h2>
              <p>외부 AI 클라이언트와 MCP 서버의 연결·호출 이력을 한 곳에서 확인합니다.</p>
            </div>
          </div>
          <div className="mcp-activity-head-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => void load(true)} disabled={refreshing}>
              <RefreshCw size={13} className={refreshing ? 'spin' : undefined} /> 새로 고침
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="MCP 활동 닫기"><X size={15} /></button>
          </div>
        </header>

        <div className="mcp-activity-summary">
          <div className="mcp-activity-stat"><span>전체 이벤트</span><strong>{events.length}</strong><small>최근 100건 · 상세 지연 조회</small></div>
          <div className={`mcp-activity-stat${failureCount > 0 ? ' danger' : ''}`}><span>실패</span><strong>{failureCount}</strong><small>{failureCount > 0 ? '확인이 필요합니다' : '실패 없음'}</small></div>
          <div className="mcp-activity-stat"><span>도구 호출</span><strong>{toolCallCount}</strong><small>tool_call</small></div>
          <div className="mcp-activity-stat"><span>세션 시작</span><strong>{sessionCount}</strong><small>session_started</small></div>
        </div>

        <div className="mcp-activity-toolbar">
          <label className="mcp-activity-search">
            <Search size={14} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="도구, 이벤트, 대상 검색" />
          </label>
          <select value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)} aria-label="상태 필터">
            <option value="all">모든 상태</option>
            <option value="success">성공만</option>
            <option value="error">실패만</option>
          </select>
          <select value={direction} onChange={(event) => setDirection(event.target.value as DirectionFilter)} aria-label="방향 필터">
            <option value="all">모든 방향</option>
            <option value="inbound">외부 AI → Rebase</option>
            <option value="outbound">Rebase → 외부 서버</option>
          </select>
          <select value={target} onChange={(event) => setTarget(event.target.value)} aria-label="대상 필터">
            <option value="all">모든 대상</option>
            {targetOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>

        <div className="mcp-activity-note">
          <ShieldNote /> 실행된 SQL 원문과 소요 시간을 표시합니다. 등록된 연결 비밀번호 같은 시크릿은 저장 전에 자동으로 가립니다.
        </div>

        {writeProposals.length > 0 && (
          <section className="mcp-write-approval" aria-labelledby="mcp-write-approval-title">
            <div className="mcp-write-approval-head">
              <div>
                <h3 id="mcp-write-approval-title">쓰기 승인 대기 <span>{writeProposals.length}</span></h3>
                <p>외부 AI가 제안한 SQL입니다. 내용을 확인한 뒤 연결별로 실행 여부를 결정하세요.</p>
              </div>
            </div>
            {proposalError && <div className="mcp-write-approval-error"><AlertTriangle size={14} /> {proposalError}</div>}
            <div className="mcp-write-approval-list">
              {writeProposals.map((proposal) => {
                const busy = proposalBusyId === proposal.id;
                return (
                  <article className="mcp-write-proposal" data-proposal-id={proposal.id} key={proposal.id}>
                    <div className="mcp-write-proposal-meta">
                      <strong>{profileLabel(proposal.profileId)}</strong>
                      <span>{formatTime(proposal.createdAt)}</span>
                      <span className={`mcp-write-risk ${proposal.risk}`}>{proposal.risk}</span>
                    </div>
                    <pre>{proposal.sql}</pre>
                    {proposal.reasons.length > 0 && <ul>{proposal.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}
                    <div className="mcp-write-proposal-actions">
                      <button className="btn btn-primary btn-sm" onClick={() => void actOnProposal(proposal.id, 'approve')} disabled={busy}>
                        {busy ? '실행 중…' : '승인 후 실행'}
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={() => void actOnProposal(proposal.id, 'reject')} disabled={busy}>거부</button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        <main className="mcp-activity-body">
          {loading ? (
            <div className="mcp-activity-empty"><span className="spinner lg" /> MCP 활동을 불러오는 중…</div>
          ) : loadError ? (
            <div className="mcp-activity-empty error"><AlertTriangle size={18} /><span>{loadError}</span></div>
          ) : filteredEvents.length === 0 ? (
            <div className="mcp-activity-empty"><Activity size={20} /><strong>{events.length === 0 ? '아직 MCP 활동이 없습니다.' : '필터에 맞는 활동이 없습니다.'}</strong><span>{events.length === 0 ? 'MCP 클라이언트를 연결하거나 외부 서버 테스트를 실행하면 여기에 표시됩니다.' : '필터를 조정해 다른 활동을 확인해 보세요.'}</span></div>
          ) : (
            <div className="mcp-activity-list-full">
              <div className="mcp-activity-list-head"><span>시간</span><span>방향</span><span>이벤트</span><span>대상</span><span>상태</span><span>소요 시간</span><span /></div>
              {filteredEvents.map((event) => {
                const expanded = expandedId === event.id;
                const inbound = event.direction === 'inbound';
                return (
                  <React.Fragment key={event.id}>
                    <button
                      className={`mcp-activity-list-row${expanded ? ' expanded' : ''}`}
                      data-event={event.event}
                      data-tool={event.tool || undefined}
                      onClick={() => void toggleEvent(event)}
                      aria-expanded={expanded}
                    >
                      <time dateTime={event.createdAt}>{formatTime(event.createdAt)}</time>
                      <span className="mcp-activity-direction">{inbound ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />} {inbound ? '인바운드' : '아웃바운드'}</span>
                      <span className="mcp-activity-event"><strong>{eventLabel(event)}</strong>{event.tool && <code>{event.tool}</code>}</span>
                      <span className="mcp-activity-target">{event.profileId ? <Database size={13} /> : <Server size={13} />}{targetLabel(event)}</span>
                      <span className={`mcp-activity-result ${event.status}`}>{event.status === 'success' ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}{event.status === 'success' ? '성공' : '실패'}</span>
                      <span className="mcp-activity-duration"><Clock3 size={12} /> {formatDuration(event.durationMs)}</span>
                      <span className="mcp-activity-expand">{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
                    </button>
                    {expanded && (
                      <div className="mcp-activity-detail">
                        <div><span>이벤트 ID</span><code>{event.id}</code></div>
                        <div><span>워크스페이스</span><code>{event.workspaceId || 'default'}</code></div>
                        {event.profileId && <div><span>프로필 ID</span><code>{event.profileId}</code></div>}
                        {event.serverId && <div><span>서버 ID</span><code>{event.serverId}</code></div>}
                        <div><span>소요 시간</span><strong className="mcp-activity-detail-duration">{formatDuration(event.durationMs)}</strong></div>
                        {loadingDetailId === event.id ? (
                          <div className="mcp-activity-query"><span>실행 쿼리</span><span className="mcp-activity-detail-loading">상세 정보를 불러오는 중…</span></div>
                        ) : event.queryText ? (
                          <div className="mcp-activity-query"><span>실행 쿼리</span><pre>{event.queryText}</pre></div>
                        ) : loadedDetailIds.has(event.id) ? (
                          <div className="mcp-activity-query"><span>실행 쿼리</span><span className="mcp-activity-detail-muted">기록된 SQL이 없습니다.</span></div>
                        ) : null}
                        {detailError && expandedId === event.id && <div className="mcp-activity-detail-error"><span>상세 조회 오류</span><strong>{detailError}</strong></div>}
                        {event.error && <div className="mcp-activity-detail-error"><span>안전한 오류 요약</span><strong>{event.error}</strong></div>}
                      </div>
                    )}
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </main>
      </div>
    </div>
  );
};

const ShieldNote: React.FC = () => (
  <span className="mcp-activity-note-icon" aria-hidden="true"><CheckCircle2 size={13} /></span>
);
