import { describe, it, expect } from 'vitest';
import { formatBytes, formatEta } from './updateFormat';

describe('formatBytes', () => {
  it('formats across units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1048576)).toBe('1.0 MB');
    expect(formatBytes(96 * 1048576)).toBe('96.0 MB');
    expect(formatBytes(1073741824)).toBe('1.0 GB');
  });
  it('handles negative/NaN as 0', () => {
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(NaN)).toBe('0 B');
  });
});

describe('formatEta', () => {
  it('returns empty when speed unknown', () => {
    expect(formatEta(0, 1000)).toBe('');
    expect(formatEta(-1, 1000)).toBe('');
  });
  it('formats seconds under a minute', () => {
    expect(formatEta(1048576, 18 * 1048576)).toBe('약 18초 남음');
  });
  it('formats minutes (ceil) at/over 60s', () => {
    expect(formatEta(1048576, 150 * 1048576)).toBe('약 3분 남음'); // 150s -> ceil 3min
    expect(formatEta(1048576, 60 * 1048576)).toBe('약 1분 남음');
  });
  it('clamps tiny remaining to at least 1s', () => {
    expect(formatEta(1048576, 1024)).toBe('약 1초 남음');
  });
});
