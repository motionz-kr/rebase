import { describe, it, expect } from 'vitest';
import { parseArgs, parseEnv, validateServer, parseHeaders } from './mcpServerForm';

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

describe('parseHeaders', () => {
  it('parses Key: Value lines, skipping blanks/comments', () => {
    expect(parseHeaders('Authorization: Bearer abc\n\n# c\nX-Tenant: 7')).toEqual({
      Authorization: 'Bearer abc',
      'X-Tenant': '7',
    });
  });
  it('splits on the first colon only', () => {
    expect(parseHeaders('X-Url: https://a:b/c')).toEqual({ 'X-Url': 'https://a:b/c' });
  });
});

describe('validateServer http', () => {
  it('requires url when transport is http', () => {
    expect(validateServer({ name: 'x', command: '', transport: 'http', url: '' })).toMatch(/URL/);
    expect(validateServer({ name: 'x', command: '', transport: 'http', url: 'https://a' })).toBe('');
  });
  it('still requires command for stdio', () => {
    expect(validateServer({ name: 'x', command: '', transport: 'stdio', url: '' })).toMatch(/명령/);
  });
});
