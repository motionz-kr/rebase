import { describe, it, expect } from 'vitest';
import { buildRecentRowsQuery } from './recentQuery';

describe('buildRecentRowsQuery', () => {
  it('mysql: orders by the primary key descending', () => {
    expect(buildRecentRowsQuery('mysql', 'users', 'id', 500)).toBe(
      'SELECT * FROM `users` ORDER BY `id` DESC LIMIT 500'
    );
  });
  it('postgres: double-quoted identifiers', () => {
    expect(buildRecentRowsQuery('postgres', 'users', 'id', 500)).toBe(
      'SELECT * FROM "users" ORDER BY "id" DESC LIMIT 500'
    );
  });
  it('falls back to no ORDER BY when there is no primary key', () => {
    expect(buildRecentRowsQuery('mysql', 'logs', null, 500)).toBe('SELECT * FROM `logs` LIMIT 500');
  });
  it('respects a custom limit', () => {
    expect(buildRecentRowsQuery('mysql', 'users', 'id', 100)).toBe(
      'SELECT * FROM `users` ORDER BY `id` DESC LIMIT 100'
    );
  });
});
