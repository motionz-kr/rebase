import { describe, expect, it } from 'vitest';
import { parseScopeList, scopeFromProfile, scopeText } from './mcpScope';

describe('mcpScope', () => {
  it('parses newline/comma lists and removes duplicates', () => {
    expect(parseScopeList('app_db, public\napp_db')).toEqual(['app_db', 'public']);
  });

  it('reads persisted JSON lists', () => {
    expect(scopeFromProfile('["app_db"]', '["public"]', '["users"]')).toEqual({
      allowedDatabases: ['app_db'],
      allowedSchemas: ['public'],
      allowedTables: ['users'],
    });
  });

  it('formats lists for the editor', () => {
    expect(scopeText(['users', 'public.orders'])).toBe('users\npublic.orders');
  });
});
