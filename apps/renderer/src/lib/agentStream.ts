// Pure helpers for accumulating a streamed agent turn into a chat transcript.

export interface ToolTrace {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  toolName: string;
  toolCallId: string;
  result: unknown;
}

export interface AgentMessage {
  role: 'user' | 'assistant';
  text: string;
  tools: ToolTrace[];
  results?: ToolResult[];
}

// A run_select / explain / profile result shaped { columns, rows }.
export interface GridResult {
  columns: string[];
  rows: unknown[][];
}

export function asGridResult(result: unknown): GridResult | null {
  if (result && typeof result === 'object') {
    const r = result as { columns?: unknown; rows?: unknown };
    if (Array.isArray(r.columns) && Array.isArray(r.rows)) {
      return { columns: r.columns as string[], rows: r.rows as unknown[][] };
    }
  }
  return null;
}

// prettyToolName strips the MCP server prefix (mcp__<server>__) so tool chips
// read as e.g. "list_tables" rather than "mcp__rebase__list_tables".
export function prettyToolName(name: string): string {
  return name.replace(/^mcp__.+?__/, '');
}

export interface AgentChunk {
  kind: 'text' | 'tool_call' | 'tool_result' | 'done' | 'error';
  text?: string;
  toolCall?: { id: string; name: string; args: Record<string, unknown> };
  toolName?: string;
  toolCallId?: string;
  result?: unknown;
  err?: string;
}

// applyAgentChunk folds one streamed chunk into the transcript by updating the
// last (assistant) message immutably. `done` is a no-op here — the caller flips
// its own busy flag when the stream ends.
export function applyAgentChunk(messages: AgentMessage[], chunk: AgentChunk): AgentMessage[] {
  if (chunk.kind === 'done') return messages;
  if (messages.length === 0) return messages;

  const idx = messages.length - 1;
  const last = messages[idx];
  if (last.role !== 'assistant') return messages;

  let next: AgentMessage;
  switch (chunk.kind) {
    case 'text':
      next = { ...last, text: last.text + (chunk.text ?? '') };
      break;
    case 'tool_call':
      next = chunk.toolCall
        ? { ...last, tools: [...last.tools, chunk.toolCall] }
        : last;
      break;
    case 'tool_result':
      next = {
        ...last,
        results: [
          ...(last.results ?? []),
          { toolName: chunk.toolName ?? '', toolCallId: chunk.toolCallId ?? '', result: chunk.result },
        ],
      };
      break;
    case 'error':
      next = { ...last, text: last.text + (last.text ? '\n\n' : '') + `⚠️ ${chunk.err ?? 'error'}` };
      break;
    default:
      next = last;
  }

  const out = messages.slice();
  out[idx] = next;
  return out;
}
