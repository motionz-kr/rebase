import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import {
  defaultModelForProvider,
  consumeLegacyAgentApiKey,
  isOAuthProvider,
  loadAgentSettings,
  modelOptionsForProvider,
  needsApiKeyProvider,
  saveAgentSettings,
  type AgentProvider,
  type AgentSettings,
} from '../lib/agentSettings';

export function AgentSettingsPanel() {
  const [settings, setSettings] = useState<AgentSettings>(loadAgentSettings);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [keyPresent, setKeyPresent] = useState<boolean | null>(null);
  const [oauthStatus, setOauthStatus] = useState<{ loading: boolean; loggedIn?: boolean } | null>(null);
  const [oauthAwaitingCode, setOauthAwaitingCode] = useState(false);
  const [oauthWaiting, setOauthWaiting] = useState(false);
  const [oauthCode, setOauthCode] = useState('');
  const [oauthError, setOauthError] = useState<string | null>(null);
  const oauthPollRef = useRef(0);

  const oauthKey = settings.provider === 'openai-oauth' ? 'openai' : 'anthropic';
  const isPasteFlow = settings.provider === 'anthropic-oauth';

  const updateSettings = (patch: Partial<AgentSettings>) => {
    setSettings(saveAgentSettings(patch));
  };

  const setProvider = (provider: AgentProvider) => {
    setApiKeyInput('');
    setOauthAwaitingCode(false);
    setOauthWaiting(false);
    setOauthCode('');
    setOauthError(null);
    updateSettings({ provider, model: defaultModelForProvider(provider, settings.model) });
  };

  const refreshKeyStatus = async () => {
    if (!needsApiKeyProvider(settings.provider)) {
      setKeyPresent(null);
      return;
    }
    const res = await window.electronAPI.agentKeyStatus(settings.provider);
    setKeyPresent(res.success && res.data ? res.data.present : false);
  };

  const saveKey = async () => {
    const key = apiKeyInput.trim();
    if (!key) return;
    await window.electronAPI.agentKeySet(settings.provider, key);
    setApiKeyInput('');
    await refreshKeyStatus();
  };

  const clearKey = async () => {
    await window.electronAPI.agentKeyClear(settings.provider);
    await refreshKeyStatus();
  };

  const refreshOAuthStatus = async () => {
    setOauthStatus({ loading: true });
    const res = await window.electronAPI.agentOAuthStatus(oauthKey);
    setOauthStatus({ loading: false, loggedIn: res.success && res.data ? res.data.loggedIn : false });
  };

  const startOAuth = async () => {
    setOauthError(null);
    const res = await window.electronAPI.agentOAuthStart(oauthKey);
    if (!res.success) {
      setOauthError(res.error || '로그인을 시작하지 못했습니다.');
      return;
    }
    if (isPasteFlow) {
      setOauthAwaitingCode(true);
      return;
    }
    setOauthWaiting(true);
    const token = ++oauthPollRef.current;
    for (let i = 0; i < 80 && oauthPollRef.current === token; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const status = await window.electronAPI.agentOAuthStatus('openai');
      if (status.success && status.data?.loggedIn) {
        if (oauthPollRef.current === token) {
          setOauthWaiting(false);
          setOauthStatus({ loading: false, loggedIn: true });
        }
        return;
      }
    }
    if (oauthPollRef.current === token) setOauthWaiting(false);
  };

  const completeOAuth = async () => {
    const code = oauthCode.trim();
    if (!code) return;
    setOauthError(null);
    setOauthStatus({ loading: true });
    const res = await window.electronAPI.agentOAuthComplete(oauthKey, code);
    if (!res.success) {
      setOauthError(res.error || '인증에 실패했습니다.');
      setOauthStatus({ loading: false, loggedIn: false });
      return;
    }
    setOauthAwaitingCode(false);
    setOauthCode('');
    await refreshOAuthStatus();
  };

  const logoutOAuth = async () => {
    oauthPollRef.current++;
    await window.electronAPI.agentOAuthLogout(oauthKey);
    setOauthAwaitingCode(false);
    setOauthWaiting(false);
    setOauthCode('');
    await refreshOAuthStatus();
  };

  useEffect(() => {
    const legacy = consumeLegacyAgentApiKey();
    if (!legacy) return;
    void window.electronAPI.agentKeySet(legacy.provider, legacy.apiKey).then(() => {
      if (settings.provider === legacy.provider) void refreshKeyStatus();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshKeyStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.provider]);

  useEffect(() => {
    oauthPollRef.current++;
    if (!isOAuthProvider(settings.provider)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshOAuthStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.provider]);

  return (
    <div className="agent-settings">
      <label>
        Provider
        <select value={settings.provider} onChange={(e) => setProvider(e.target.value as AgentProvider)}>
          <option value="anthropic-oauth">Claude (구독 로그인 - API 키 불필요)</option>
          <option value="openai-oauth">Codex / ChatGPT (구독 로그인 - API 키 불필요)</option>
          <option value="anthropic">Anthropic API key</option>
          <option value="openai">OpenAI API key</option>
        </select>
      </label>

      <label>
        Model
        <select value={settings.model} onChange={(e) => updateSettings({ model: e.target.value })}>
          {modelOptionsForProvider(settings.provider, settings.model).map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>

      {isOAuthProvider(settings.provider) && (
        <div className="agent-cli-status">
          <p className="agent-settings-note">
            {settings.provider === 'openai-oauth' ? 'ChatGPT Plus/Pro' : 'Claude Pro/Max'} 구독으로 로그인합니다. API 키가 필요 없습니다.
          </p>
          {oauthStatus?.loading && <div className="cli-line">확인 중...</div>}
          {oauthStatus && !oauthStatus.loading && oauthStatus.loggedIn && (
            <div className="cli-line ok">
              <Check size={13} /> 로그인됨
            </div>
          )}
          {oauthStatus && !oauthStatus.loading && !oauthStatus.loggedIn && !oauthAwaitingCode && !oauthWaiting && (
            <div className="cli-line warn">
              <AlertTriangle size={13} />
              <span>로그인이 필요합니다.</span>
            </div>
          )}
          {oauthWaiting && (
            <div className="cli-line">
              <span className="spinner" /> 브라우저에서 로그인을 완료하세요...
            </div>
          )}
          {oauthAwaitingCode && (
            <div className="agent-oauth-paste">
              <p className="agent-settings-note">브라우저에서 로그인/승인 후 표시되는 인증 코드를 붙여넣으세요.</p>
              <input
                type="text"
                value={oauthCode}
                onChange={(e) => setOauthCode(e.target.value)}
                placeholder="인증 코드 (code#state)"
                autoFocus
              />
            </div>
          )}
          {oauthError && (
            <div className="cli-line warn">
              <AlertTriangle size={13} />
              <span>{oauthError}</span>
            </div>
          )}
          <div className="cli-actions">
            {oauthStatus?.loggedIn ? (
              <button className="btn btn-secondary btn-sm" onClick={() => void logoutOAuth()}>
                로그아웃
              </button>
            ) : oauthAwaitingCode ? (
              <button className="btn btn-primary btn-sm" onClick={() => void completeOAuth()} disabled={!oauthCode.trim()}>
                완료
              </button>
            ) : (
              <button className="btn btn-primary btn-sm" onClick={() => void startOAuth()} disabled={oauthWaiting}>
                로그인
              </button>
            )}
            <button className="btn btn-secondary btn-sm" onClick={() => void refreshOAuthStatus()} disabled={oauthStatus?.loading}>
              다시 확인
            </button>
          </div>
        </div>
      )}

      {needsApiKeyProvider(settings.provider) && (
        <>
          <label>
            API key
            <div className="agent-key-row">
              <input
                type="password"
                value={apiKeyInput}
                placeholder={keyPresent ? 'Stored - enter a new key to replace' : settings.provider === 'openai' ? 'sk-...' : 'sk-ant-...'}
                onChange={(e) => setApiKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void saveKey();
                  }
                }}
              />
              <button className="btn btn-primary btn-sm" onClick={() => void saveKey()} disabled={!apiKeyInput.trim()}>
                Save
              </button>
            </div>
          </label>
          {keyPresent !== null && (
            <div className="agent-key-status">
              {keyPresent ? (
                <span className="cli-line ok">
                  <Check size={13} /> Key stored in keychain
                  <button className="btn btn-secondary btn-xs" onClick={() => void clearKey()}>
                    Remove
                  </button>
                </span>
              ) : (
                <span className="cli-line warn">
                  <AlertTriangle size={13} /> No key stored for this provider
                </span>
              )}
            </div>
          )}
          <p className="agent-settings-note">
            The key is stored in your OS keychain via the local engine, then sent only to the{' '}
            {settings.provider === 'openai' ? 'OpenAI' : 'Anthropic'} API.
          </p>
        </>
      )}

      <label>
        Startup mode
        <select value={settings.startupView} onChange={(e) => updateSettings({ startupView: e.target.value as AgentSettings['startupView'] })}>
          <option value="default">Default workspace</option>
          <option value="agent">Agent mode (expanded)</option>
        </select>
      </label>

      <label>
        Autonomy
        <select value={settings.autonomy} onChange={(e) => updateSettings({ autonomy: e.target.value as AgentSettings['autonomy'] })}>
          <option value="approval">Approval (you run every write)</option>
          <option value="autonomous">Autonomous (auto-run safe writes)</option>
        </select>
      </label>

      <label>
        Data exposure
        <select
          value={settings.dataExposure}
          onChange={(e) => updateSettings({ dataExposure: e.target.value as AgentSettings['dataExposure'] })}
        >
          <option value="metadata">Metadata only (no row values to model)</option>
          <option value="on_request">On request</option>
          <option value="unrestricted">Unrestricted</option>
        </select>
      </label>

      <label>
        Response language
        <select
          value={settings.responseLanguage}
          onChange={(e) => updateSettings({ responseLanguage: e.target.value as AgentSettings['responseLanguage'] })}
        >
          <option value="korean">Korean (한국어)</option>
          <option value="english">English</option>
        </select>
      </label>

      {settings.autonomy === 'autonomous' && settings.dataExposure === 'unrestricted' && (
        <p className="agent-settings-note warn">Autonomous + Unrestricted is the least restrictive combination.</p>
      )}
    </div>
  );
}
