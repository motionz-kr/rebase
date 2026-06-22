// Shared read of the agent provider settings (mirrors the key written by
// AgentChat) so other AI features (e.g. result narration) use the same provider.
export const AGENT_SETTINGS_KEY = 'rebase.agent.settings';
export const AGENT_SETTINGS_EVENT = 'rebase-agent-settings-change';

export type AgentProvider = 'anthropic' | 'anthropic-oauth' | 'openai' | 'openai-oauth';
export const AGENT_PROVIDERS: AgentProvider[] = ['anthropic', 'anthropic-oauth', 'openai', 'openai-oauth'];

export interface AgentSettings {
  provider: AgentProvider;
  model: string;
  autonomy: 'approval' | 'autonomous';
  dataExposure: 'metadata' | 'on_request' | 'unrestricted';
  responseLanguage: 'korean' | 'english';
  startupView: 'default' | 'agent';
}

const DEFAULTS: AgentSettings = {
  provider: 'anthropic-oauth',
  model: 'claude-sonnet-4-6',
  autonomy: 'approval',
  dataExposure: 'metadata',
  responseLanguage: 'korean',
  startupView: 'default',
};

function sanitizeSettings(parsed: Record<string, unknown>): AgentSettings {
  const provider = AGENT_PROVIDERS.includes(parsed.provider as AgentProvider)
    ? (parsed.provider as AgentProvider)
    : DEFAULTS.provider;
  return {
    provider,
    model: typeof parsed.model === 'string' ? parsed.model : DEFAULTS.model,
    autonomy: parsed.autonomy === 'autonomous' ? 'autonomous' : DEFAULTS.autonomy,
    dataExposure:
      parsed.dataExposure === 'on_request' || parsed.dataExposure === 'unrestricted' || parsed.dataExposure === 'metadata'
        ? parsed.dataExposure
        : DEFAULTS.dataExposure,
    responseLanguage: parsed.responseLanguage === 'english' ? 'english' : DEFAULTS.responseLanguage,
    startupView: parsed.startupView === 'agent' ? 'agent' : DEFAULTS.startupView,
  };
}

export function loadAgentSettings(): AgentSettings {
  try {
    const raw = localStorage.getItem(AGENT_SETTINGS_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const next = sanitizeSettings(parsed);
    const storageValue = typeof parsed.apiKey === 'string' ? { ...next, apiKey: parsed.apiKey } : next;
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify(storageValue));
    return next;
  } catch {
    return { ...DEFAULTS };
  }
}

export function consumeLegacyAgentApiKey(): { provider: Extract<AgentProvider, 'anthropic' | 'openai'>; apiKey: string } | null {
  try {
    const raw = localStorage.getItem(AGENT_SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const next = sanitizeSettings(parsed);
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify(next));

    const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
    if (!apiKey || (next.provider !== 'anthropic' && next.provider !== 'openai')) return null;
    return { provider: next.provider, apiKey };
  } catch {
    return null;
  }
}

export function saveAgentSettings(patch: Partial<AgentSettings>): AgentSettings {
  const next = { ...loadAgentSettings(), ...patch };
  localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent<AgentSettings>(AGENT_SETTINGS_EVENT, { detail: next }));
  return next;
}

export function isOAuthProvider(p: AgentProvider): boolean {
  return p === 'anthropic-oauth' || p === 'openai-oauth';
}

export function needsApiKeyProvider(p: AgentProvider): boolean {
  return p === 'anthropic' || p === 'openai';
}

export function defaultModelForProvider(provider: AgentProvider, current: string): string {
  if (provider === 'openai' && current.startsWith('claude')) return 'gpt-4o';
  if (provider === 'anthropic-oauth') return 'claude-sonnet-4-6';
  if (provider === 'openai-oauth') return 'gpt-5.4';
  if (provider === 'anthropic' && current.startsWith('gpt')) return 'claude-sonnet-4-6';
  return current;
}

export function modelOptionsForProvider(provider: AgentProvider, current: string): string[] {
  let presets: string[];
  if (provider === 'openai') {
    presets = ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'];
  } else if (provider === 'anthropic-oauth') {
    presets = ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6'];
  } else if (provider === 'openai-oauth') {
    presets = ['gpt-5.5', 'gpt-5.4'];
  } else {
    presets = ['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-6'];
  }
  return Array.from(new Set(current ? [current, ...presets] : presets));
}
