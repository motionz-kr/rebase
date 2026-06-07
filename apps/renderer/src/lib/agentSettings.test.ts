import { describe, it, expect, beforeEach } from 'vitest';
import { loadAgentSettings, AGENT_SETTINGS_KEY } from './agentSettings';

describe('agentSettings', () => {
  beforeEach(() => localStorage.clear());
  it('returns defaults when nothing stored', () => {
    const s = loadAgentSettings();
    expect(s.provider).toBe('anthropic-oauth');
    expect(s.dataExposure).toBe('metadata');
  });
  it('reads stored settings', () => {
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify({ provider: 'openai', model: 'gpt-x', dataExposure: 'unrestricted' }));
    const s = loadAgentSettings();
    expect(s.provider).toBe('openai');
    expect(s.model).toBe('gpt-x');
  });
  it('survives malformed JSON', () => {
    localStorage.setItem(AGENT_SETTINGS_KEY, '{bad');
    expect(loadAgentSettings().provider).toBe('anthropic-oauth');
  });
});
