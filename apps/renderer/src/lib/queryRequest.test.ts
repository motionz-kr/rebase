import { describe, expect, it } from 'vitest';
import { createSqlQueryRequest } from './queryRequest';

describe('createSqlQueryRequest', () => {
  it('keeps the selected database with a query execution request', () => {
    expect(createSqlQueryRequest('profile-1', 'analytics', 'SELECT * FROM orders', true, 42)).toEqual({
      profileId: 'profile-1',
      database: 'analytics',
      sql: 'SELECT * FROM orders',
      execute: true,
      nonce: 42,
    });
  });

  it('creates a non-executing request for entering the query editor', () => {
    expect(createSqlQueryRequest('profile-1', 'reporting', '', false, 43)).toEqual({
      profileId: 'profile-1',
      database: 'reporting',
      sql: '',
      execute: false,
      nonce: 43,
    });
  });

  it('marks schema actions that must open a dedicated query tab', () => {
    expect(createSqlQueryRequest('profile-1', 'reporting', 'SELECT 1', true, 44, true)).toMatchObject({
      profileId: 'profile-1',
      database: 'reporting',
      sql: 'SELECT 1',
      execute: true,
      nonce: 44,
      openInNewTab: true,
    });
  });
});
