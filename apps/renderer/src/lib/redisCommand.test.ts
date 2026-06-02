import { describe, it, expect } from 'vitest';
import { tokenizeCommand, isDangerousCommand } from './redisCommand';

describe('tokenizeCommand', () => {
  it('splits a simple command on whitespace', () => {
    expect(tokenizeCommand('GET user:1')).toEqual(['GET', 'user:1']);
  });

  it('collapses runs of whitespace', () => {
    expect(tokenizeCommand('  SET   a    b ')).toEqual(['SET', 'a', 'b']);
  });

  it('keeps a double-quoted segment as one token', () => {
    expect(tokenizeCommand('SET greeting "hello world"')).toEqual(['SET', 'greeting', 'hello world']);
  });

  it('keeps a single-quoted segment as one token', () => {
    expect(tokenizeCommand("SET k 'a b c'")).toEqual(['SET', 'k', 'a b c']);
  });

  it('supports escaped quotes inside double quotes', () => {
    expect(tokenizeCommand('SET k "a\\"b"')).toEqual(['SET', 'k', 'a"b']);
  });

  it('returns an empty array for blank input', () => {
    expect(tokenizeCommand('   ')).toEqual([]);
    expect(tokenizeCommand('')).toEqual([]);
  });
});

describe('isDangerousCommand', () => {
  it('flags FLUSHALL / FLUSHDB case-insensitively', () => {
    expect(isDangerousCommand(['flushall'])).toBe(true);
    expect(isDangerousCommand(['FLUSHDB'])).toBe(true);
    expect(isDangerousCommand(['FlushDb', 'async'])).toBe(true);
  });

  it('flags KEYS and SWAPDB (operationally risky)', () => {
    expect(isDangerousCommand(['KEYS', '*'])).toBe(true);
  });

  it('does not flag ordinary reads/writes', () => {
    expect(isDangerousCommand(['GET', 'x'])).toBe(false);
    expect(isDangerousCommand(['SET', 'x', '1'])).toBe(false);
    expect(isDangerousCommand([])).toBe(false);
  });
});
