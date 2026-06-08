import { describe, it, expect } from 'vitest';
import { parseArgs, parseEnv, validateServer, proxyToolLabel } from './mcpServerForm';

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

describe('proxyToolLabel', () => {
  it('splits mcp__server__tool into parts', () => {
    expect(proxyToolLabel('mcp__files__read_file')).toEqual({ server: 'files', tool: 'read_file' });
    expect(proxyToolLabel('list_tables')).toBeNull();
  });
});
