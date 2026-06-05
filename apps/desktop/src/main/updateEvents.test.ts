import { describe, it, expect } from 'vitest';
import { mapUpdaterEvent } from './updateEvents';

describe('mapUpdaterEvent', () => {
  it('maps checking-for-update', () => {
    expect(mapUpdaterEvent('checking-for-update', undefined)).toEqual({ kind: 'checking' });
  });
  it('maps update-available with version + notes', () => {
    expect(mapUpdaterEvent('update-available', { version: '0.2.0', releaseNotes: 'fixes' })).toEqual({
      kind: 'available',
      version: '0.2.0',
      notes: 'fixes',
    });
  });
  it('maps update-not-available', () => {
    expect(mapUpdaterEvent('update-not-available', { version: '0.1.0' })).toEqual({ kind: 'not-available' });
  });
  it('rounds download-progress percent and carries size + speed', () => {
    expect(
      mapUpdaterEvent('download-progress', { percent: 42.7, transferred: 500, total: 1000, bytesPerSecond: 250 })
    ).toEqual({ kind: 'progress', percent: 43, transferred: 500, total: 1000, bytesPerSecond: 250 });
  });
  it('defaults missing download-progress size + speed fields to 0', () => {
    expect(mapUpdaterEvent('download-progress', { percent: 10 })).toEqual({
      kind: 'progress',
      percent: 10,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
    });
  });
  it('maps update-downloaded with version', () => {
    expect(mapUpdaterEvent('update-downloaded', { version: '0.2.0' })).toEqual({ kind: 'downloaded', version: '0.2.0' });
  });
  it('maps error to a message string', () => {
    expect(mapUpdaterEvent('error', new Error('boom'))).toEqual({ kind: 'error', message: 'boom' });
  });
  it('ignores unknown events', () => {
    expect(mapUpdaterEvent('something-else', {})).toBeNull();
  });
});
