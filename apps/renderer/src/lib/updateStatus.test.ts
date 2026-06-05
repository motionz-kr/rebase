import { describe, it, expect } from 'vitest';
import { updateReducer, initialUpdateState } from './updateStatus';

describe('updateReducer', () => {
  it('starts idle', () => {
    expect(initialUpdateState).toEqual({ phase: 'idle' });
  });
  it('checking → checking', () => {
    expect(updateReducer(initialUpdateState, { kind: 'checking' })).toEqual({ phase: 'checking' });
  });
  it('available carries version + notes', () => {
    expect(updateReducer(initialUpdateState, { kind: 'available', version: '0.2.0', notes: 'x' })).toEqual({
      phase: 'available',
      version: '0.2.0',
      notes: 'x',
    });
  });
  it('not-available → idle', () => {
    const s = updateReducer(initialUpdateState, { kind: 'available', version: '0.2.0' });
    expect(updateReducer(s, { kind: 'not-available' })).toEqual({ phase: 'idle' });
  });
  it('progress keeps version from the available state and carries size + speed', () => {
    const s = updateReducer(initialUpdateState, { kind: 'available', version: '0.2.0' });
    expect(
      updateReducer(s, { kind: 'progress', percent: 50, transferred: 500, total: 1000, bytesPerSecond: 250 })
    ).toEqual({
      phase: 'downloading',
      version: '0.2.0',
      percent: 50,
      transferred: 500,
      total: 1000,
      bytesPerSecond: 250,
    });
  });
  it('downloaded → downloaded with version', () => {
    expect(updateReducer(initialUpdateState, { kind: 'downloaded', version: '0.2.0' })).toEqual({
      phase: 'downloaded',
      version: '0.2.0',
    });
  });
  it('error carries the message', () => {
    expect(updateReducer(initialUpdateState, { kind: 'error', message: 'boom' })).toEqual({
      phase: 'error',
      message: 'boom',
    });
  });
});
