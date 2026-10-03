import type { DatabaseDiscoveryResult, DiscoveredDatabase } from '../global';

export type DiscoveredConnectionDefaults = {
  driver: DiscoveredDatabase['driver'];
  host: string;
  port: number;
  name: string;
  database: string;
  username: string;
};

const DRIVER_NAMES: Record<DiscoveredDatabase['driver'], string> = {
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
  redis: 'Redis',
  sqlserver: 'SQL Server',
  mongodb: 'MongoDB',
};

export function connectionDefaultsFromCandidate(candidate: DiscoveredDatabase): DiscoveredConnectionDefaults {
  const driverName = DRIVER_NAMES[candidate.driver];
  return {
    driver: candidate.driver,
    host: candidate.host,
    port: candidate.port,
    name: `${driverName} · ${candidate.host}:${candidate.port}`,
    database: candidate.driver === 'redis' ? '0' : '',
    username: '',
  };
}

export function discoverySourceLabel(candidate: DiscoveredDatabase): string {
  return candidate.source === 'docker' && candidate.sourceName
    ? `Docker · ${candidate.sourceName}`
    : '이 PC에서 실행 중';
}

export function dockerDiscoveryMessage(result: DatabaseDiscoveryResult): string | null {
  if (result.dockerStatus === 'remote_context') return '현재 Docker 연결은 원격 환경이라 검색에서 제외했습니다.';
  if (result.dockerStatus === 'skipped') return 'Docker 검색을 사용할 수 없어 로컬 포트만 확인했습니다.';
  return null;
}
