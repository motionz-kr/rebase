import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { EngineManager } from './engine_manager';
import { EventEmitter } from 'events';

vi.mock('child_process', () => {
  return {
    spawn: vi.fn().mockReturnValue({
      pid: 12345,
      kill: vi.fn(),
      on: vi.fn(),
    }),
  };
});

describe('EngineManager', () => {
  const handshakePath = path.join(__dirname, 'test_handshake.json');

  beforeEach(() => {
    if (fs.existsSync(handshakePath)) {
      fs.unlinkSync(handshakePath);
    }
  });

  afterEach(() => {
    if (fs.existsSync(handshakePath)) {
      fs.unlinkSync(handshakePath);
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should start Go engine, write/read handshake, and stop Go engine', async () => {
    const manager = new EngineManager({
      binaryPath: 'fake-engine-path',
      handshakePath,
      token: 'test-token',
    });

    setTimeout(() => {
      fs.writeFileSync(
        handshakePath,
        JSON.stringify({
          port: 4567,
          pid: 12345,
          ready: true,
          startedAt: new Date().toISOString(),
        })
      );
    }, 100);

    const ready = await manager.start();

    expect(ready).toBe(true);
    expect(manager.getPort()).toBe(4567);
    expect(manager.getPid()).toBe(12345);

    await manager.stop();
    expect(manager.getPid()).toBeNull();
  });

  it('allows remote SSM cleanup to finish before escalating shutdown', async () => {
    vi.useFakeTimers();
    const manager = new EngineManager({ binaryPath: 'fake', handshakePath, token: 'test' });
    const proc = Object.assign(new EventEmitter(), { exitCode: null, killed: false, kill: vi.fn() });
    Object.assign(manager, { process: proc });
    const stopped = manager.stop();
    await vi.advanceTimersByTimeAsync(4000);
    expect(proc.kill.mock.calls).toEqual([['SIGTERM']]);
    proc.emit('exit', 0);
    await stopped;
    await vi.advanceTimersByTimeAsync(10000);
    expect(proc.kill.mock.calls).toEqual([['SIGTERM']]);
  });

  it('still force-kills an engine that never finishes cleanup', async () => {
    vi.useFakeTimers();
    const manager = new EngineManager({ binaryPath: 'fake', handshakePath, token: 'test' });
    const proc = Object.assign(new EventEmitter(), { exitCode: null, killed: false, kill: vi.fn() });
    Object.assign(manager, { process: proc });
    const stopped = manager.stop();
    await vi.advanceTimersByTimeAsync(10000);
    await stopped;
    expect(proc.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  });
});
