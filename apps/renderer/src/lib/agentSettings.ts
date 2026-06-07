// Shared read of the agent provider settings (mirrors the key written by
// AgentChat) so other AI features (e.g. result narration) use the same provider.
export const AGENT_SETTINGS_KEY = 'rebase.agent.settings';

export type AgentProvider = 'anthropic' | 'anthropic-oauth' | 'openai' | 'openai-oauth';

export interface AgentSettings {
  provider: AgentProvider;
  model: string;
  dataExposure: 'metadata' | 'on_request' | 'unrestricted';
}

const DEFAULTS: AgentSettings = {
  provider: 'anthropic-oauth',
  model: 'claude-sonnet-4-6',
  dataExposure: 'metadata',
};

export function loadAgentSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(AGENT_SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      provider: parsed.provider ?? DEFAULTS.provider,
      model: parsed.model ?? DEFAULTS.model,
      dataExposure: parsed.dataExposure ?? DEFAULTS.dataExposure,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function isOAuthProvider(p: AgentProvider): boolean {
  return p === 'anthropic-oauth' || p === 'openai-oauth';
}
