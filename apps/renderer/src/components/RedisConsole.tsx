import React, { useState, useRef, useEffect } from 'react';
import { TerminalSquare, CornerDownLeft, AlertTriangle } from 'lucide-react';
import { tokenizeCommand, isDangerousCommand } from '../lib/redisCommand';

interface RedisConsoleProps {
  profileId: string;
}

interface ConsoleEntry {
  command: string;
  output: string;
  isError: boolean;
}

export const RedisConsole: React.FC<RedisConsoleProps> = ({ profileId }) => {
  const [input, setInput] = useState('');
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [pendingDangerous, setPendingDangerous] = useState<string[] | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);

  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [entries, pendingDangerous]);

  const run = async (args: string[], raw: string) => {
    setBusy(true);
    try {
      const res = await window.electronAPI.redisCommand(profileId, args);
      if (res.success && res.data) {
        setEntries((prev) => [...prev, { command: raw, output: res.data!.output, isError: res.data!.isError }]);
      } else {
        setEntries((prev) => [...prev, { command: raw, output: res.error || 'Command failed', isError: true }]);
      }
    } catch (e: any) {
      setEntries((prev) => [...prev, { command: raw, output: e.message || 'Error', isError: true }]);
    } finally {
      setBusy(false);
      setHistory((prev) => (prev[prev.length - 1] === raw ? prev : [...prev, raw]));
      setHistIdx(-1);
    }
  };

  const submit = () => {
    const raw = input.trim();
    if (!raw || busy) return;
    const args = tokenizeCommand(raw);
    if (args.length === 0) return;
    setInput('');
    if (isDangerousCommand(args)) {
      setPendingDangerous(args);
      return;
    }
    run(args, raw);
  };

  const confirmDangerous = () => {
    if (!pendingDangerous) return;
    const args = pendingDangerous;
    setPendingDangerous(null);
    run(args, args.join(' '));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'ArrowUp') {
      if (history.length === 0) return;
      e.preventDefault();
      const next = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next);
      setInput(history[next]);
    } else if (e.key === 'ArrowDown') {
      if (histIdx === -1) return;
      e.preventDefault();
      const next = histIdx + 1;
      if (next >= history.length) {
        setHistIdx(-1);
        setInput('');
      } else {
        setHistIdx(next);
        setInput(history[next]);
      }
    }
  };

  return (
    <div className="redis-console">
      <div className="redis-console-head">
        <span className="tree-icon">
          <TerminalSquare size={15} />
        </span>
        <h2>Command console</h2>
        {entries.length > 0 && (
          <button className="btn btn-secondary btn-xs" onClick={() => setEntries([])} disabled={busy}>
            Clear
          </button>
        )}
      </div>

      <div className="redis-console-log" ref={logRef}>
        {entries.length === 0 && (
          <div className="redis-console-hint">
            Type a Redis command and press <kbd>Enter</kbd>. Try <code>PING</code>, <code>INFO server</code>, or{' '}
            <code>GET mykey</code>. Quote arguments with spaces: <code>SET k "a b"</code>.
          </div>
        )}
        {entries.map((e, i) => (
          <div className="redis-console-entry" key={i}>
            <div className="redis-console-cmd">
              <span className="redis-console-prompt">&gt;</span> {e.command}
            </div>
            <pre className={`redis-console-out${e.isError ? ' is-error' : ''}`}>{e.output}</pre>
          </div>
        ))}
      </div>

      {pendingDangerous ? (
        <div className="redis-console-confirm">
          <AlertTriangle size={14} />
          <span>
            Run <code>{pendingDangerous.join(' ')}</code>? This may destroy or scan the whole keyspace.
          </span>
          <button className="btn btn-danger btn-sm" onClick={confirmDangerous} disabled={busy}>
            Run anyway
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => setPendingDangerous(null)} disabled={busy}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="redis-console-input">
          <span className="redis-console-prompt">&gt;</span>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Redis command…"
            spellCheck={false}
            autoFocus
            disabled={busy}
          />
          <button className="icon-btn" onClick={submit} disabled={busy || !input.trim()} title="Run (Enter)">
            <CornerDownLeft size={14} />
          </button>
        </div>
      )}
    </div>
  );
};
