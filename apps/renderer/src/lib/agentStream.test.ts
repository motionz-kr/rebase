import { describe, it, expect } from 'vitest';
import { applyAgentChunk, prettyToolName, type AgentMessage } from './agentStream';

describe('prettyToolName', () => {
  it('strips the mcp server prefix', () => {
    expect(prettyToolName('mcp__rebase__list_tables')).toBe('list_tables');
    expect(prettyToolName('mcp__rebase__propose_write')).toBe('propose_write');
  });
  it('leaves plain tool names unchanged', () => {
    expect(prettyToolName('list_tables')).toBe('list_tables');
    expect(prettyToolName('ToolSearch')).toBe('ToolSearch');
  });
});

const base = (): AgentMessage[] => [
  { role: 'user', text: 'how many tables?', tools: [] },
  { role: 'assistant', text: '', tools: [] },
];

describe('applyAgentChunk', () => {
  it('appends streamed text to the last assistant message', () => {
    let m = base();
    m = applyAgentChunk(m, { kind: 'text', text: 'There are ' });
    m = applyAgentChunk(m, { kind: 'text', text: '2 tables.' });
    expect(m[1].text).toBe('There are 2 tables.');
    expect(m[0].text).toBe('how many tables?'); // user untouched
  });

  it('records a tool call in the assistant trace', () => {
    let m = base();
    m = applyAgentChunk(m, { kind: 'tool_call', toolCall: { id: 't1', name: 'list_tables', args: {} } });
    expect(m[1].tools).toHaveLength(1);
    expect(m[1].tools[0].name).toBe('list_tables');
  });

  it('surfaces an error into the assistant message', () => {
    let m = base();
    m = applyAgentChunk(m, { kind: 'error', err: 'boom' });
    expect(m[1].text).toContain('boom');
  });

  it('treats done as a no-op on the transcript', () => {
    const m = base();
    expect(applyAgentChunk(m, { kind: 'done' })).toEqual(m);
  });

  it('does not mutate the input array', () => {
    const m = base();
    const out = applyAgentChunk(m, { kind: 'text', text: 'x' });
    expect(out).not.toBe(m);
    expect(m[1].text).toBe('');
  });
});
