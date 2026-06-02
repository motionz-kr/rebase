// Pure helpers for accumulating a streamed agent turn into a chat transcript.

export interface ToolTrace {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AgentMessage {
  role: 'user' | 'assistant';
  text: string;
  tools: ToolTrace[];
}

export interface AgentChunk {
  kind: 'text' | 'tool_call' | 'done' | 'error';
  text?: string;
  toolCall?: { id: string; name: string; args: Record<string, unknown> };
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
