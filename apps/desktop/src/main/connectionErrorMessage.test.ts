import { describe, expect, it } from 'vitest';
import { connectionErrorMessage } from './connectionErrorMessage';

describe('connection test error display', () => {
  it('shows the engine message without its JSON envelope', () => {
    expect(connectionErrorMessage('{"error":"SSH: 호스트 키를 확인하세요"}')).toBe('SSH: 호스트 키를 확인하세요');
  });
  it('preserves plain text and malformed responses', () => {
    expect(connectionErrorMessage('Connection refused')).toBe('Connection refused');
    expect(connectionErrorMessage('{broken')).toBe('{broken');
  });
  it('does not replace errors with non-string payloads', () => {
    expect(connectionErrorMessage('{"error":null}')).toBe('{"error":null}');
  });
});
