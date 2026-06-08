import { describe, it, expect } from 'vitest';
import { parseArgs, parseEnv, validateServer } from './mcpServerForm';

describe('parseArgs', () => {
  it('splits on whitespace, ignoring blanks', () => {
    expect(parseArgs('-y  @scope/server   /tmp')).toEqual(['-y', '@scope/server', '/tmp']);
    expect(parseArgs('')).toEqual([]);
  });
});

describe('parseEnv', () => {
  it('parses KEY=VALUE lines, skipping blanks/comments', () => {
    expect(parseEnv('API_KEY=abc\n\n# note\nTOKEN=xyz')).toEqual({ API_KEY: 'abc', TOKEN: 'xyz' });
  });
});

describe('validateServer', () => {
  it('requires name and command', () => {
    expect(validateServer({ name: '', command: 'npx' })).toMatch(/이름/);
    expect(validateServer({ name: 'x', command: '' })).toMatch(/명령/);
    expect(validateServer({ name: 'x', command: 'npx' })).toBe('');
  });
});
