import { describe, expect, it } from 'vitest';
import type { DatabaseDiscoveryResult, DiscoveredDatabase } from '../global';
import { connectionDefaultsFromCandidate, discoverySourceLabel, dockerDiscoveryMessage } from './databaseDiscovery';

describe('database discovery presentation', () => {
  it('fills only safe connection basics and does not guess credentials or database names', () => {
    const candidate: DiscoveredDatabase = {
      id: 'candidate-1', driver: 'mysql', host: '127.0.0.1', port: 3307, source: 'docker', sourceName: 'test-db',
    };
    expect(connectionDefaultsFromCandidate(candidate)).toEqual({
      driver: 'mysql', host: '127.0.0.1', port: 3307, name: 'MySQL · 127.0.0.1:3307', database: '', username: '',
    });
    expect(discoverySourceLabel(candidate)).toBe('Docker · test-db');
  });

  it('keeps source context as a secondary label for local services', () => {
    expect(discoverySourceLabel({
      id: 'candidate-2', driver: 'postgres', host: '127.0.0.1', port: 5432, source: 'local',
    })).toBe('이 PC에서 실행 중');
  });

  it('explains partial Docker discovery without blocking local candidates', () => {
    const result: DatabaseDiscoveryResult = { candidates: [], dockerStatus: 'remote_context' };
    expect(dockerDiscoveryMessage(result)).toContain('원격 환경');
  });
});
