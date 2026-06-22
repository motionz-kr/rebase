import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadAgentSettings,
  saveAgentSettings,
  modelOptionsForProvider,
  AGENT_SETTINGS_KEY,
  consumeLegacyAgentApiKey,
} from './agentSettings';

describe('agentSettings', () => {
  beforeEach(() => localStorage.clear());
  it('returns defaults when nothing stored', () => {
    const s = loadAgentSettings();
    expect(s.provider).toBe('anthropic-oauth');
    expect(s.dataExposure).toBe('metadata');
    expect(s.autonomy).toBe('approval');
    expect(s.responseLanguage).toBe('korean');
  });
  it('reads stored settings', () => {
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify({ provider: 'openai', model: 'gpt-x', dataExposure: 'unrestricted', autonomy: 'autonomous', responseLanguage: 'english' }));
    const s = loadAgentSettings();
    expect(s.provider).toBe('openai');
    expect(s.model).toBe('gpt-x');
    expect(s.autonomy).toBe('autonomous');
    expect(s.responseLanguage).toBe('english');
  });
  it('survives malformed JSON', () => {
    localStorage.setItem(AGENT_SETTINGS_KEY, '{bad');
    expect(loadAgentSettings().provider).toBe('anthropic-oauth');
  });
  it('drops invalid providers', () => {
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify({ provider: 'stub', apiKey: 'secret', model: 'x' }));
    const s = loadAgentSettings();
    expect(s.provider).toBe('anthropic-oauth');
  });
  it('keeps legacy plaintext api keys until they are consumed for keychain migration', () => {
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify({ provider: 'openai', apiKey: 'secret', model: 'gpt-x' }));
    expect(loadAgentSettings().provider).toBe('openai');
    expect(JSON.parse(localStorage.getItem(AGENT_SETTINGS_KEY) || '{}')).toHaveProperty('apiKey', 'secret');

    expect(consumeLegacyAgentApiKey()).toEqual({ provider: 'openai', apiKey: 'secret' });
    expect(JSON.parse(localStorage.getItem(AGENT_SETTINGS_KEY) || '{}')).not.toHaveProperty('apiKey');
  });
  it('removes legacy plaintext api keys without migrating subscription providers', () => {
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify({ provider: 'anthropic-oauth', apiKey: 'secret' }));
    expect(consumeLegacyAgentApiKey()).toBeNull();
    expect(JSON.parse(localStorage.getItem(AGENT_SETTINGS_KEY) || '{}')).not.toHaveProperty('apiKey');
  });
  it('saves partial patches without losing existing settings', () => {
    const next = saveAgentSettings({ provider: 'openai', model: 'gpt-4o' });
    expect(next.provider).toBe('openai');
    expect(next.model).toBe('gpt-4o');
    expect(next.dataExposure).toBe('metadata');
    expect(next.responseLanguage).toBe('korean');
    expect(loadAgentSettings().provider).toBe('openai');
  });
  it('sanitizes invalid response language', () => {
    localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify({ responseLanguage: 'spanish' }));
    expect(loadAgentSettings().responseLanguage).toBe('korean');
  });
  it('includes the current custom model in provider options', () => {
    expect(modelOptionsForProvider('openai-oauth', 'custom-model')).toContain('custom-model');
  });
});
