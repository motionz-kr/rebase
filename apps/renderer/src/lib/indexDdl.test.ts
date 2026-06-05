import { describe, it, expect } from 'vitest';
import { buildCreateIndex, buildDropIndex } from './indexDdl';

describe('buildCreateIndex', () => {
  it('mysql: single column', () => {
    expect(buildCreateIndex('mysql', { table: 'users', name: 'idx_email', columns: ['email'], unique: false })).toBe(
      'CREATE INDEX `idx_email` ON `users` (`email`)'
    );
  });
  it('mysql: composite + unique', () => {
    expect(buildCreateIndex('mysql', { table: 'users', name: 'ux_ab', columns: ['a', 'b'], unique: true })).toBe(
      'CREATE UNIQUE INDEX `ux_ab` ON `users` (`a`, `b`)'
    );
  });
  it('postgres: double-quoted identifiers', () => {
    expect(buildCreateIndex('postgres', { table: 'users', name: 'idx_email', columns: ['email'], unique: false })).toBe(
      'CREATE INDEX "idx_email" ON "users" ("email")'
    );
  });
  it('postgres: composite + unique', () => {
    expect(buildCreateIndex('postgres', { table: 'users', name: 'ux_ab', columns: ['a', 'b'], unique: true })).toBe(
      'CREATE UNIQUE INDEX "ux_ab" ON "users" ("a", "b")'
    );
  });
});

describe('buildDropIndex', () => {
  it('mysql: needs the table', () => {
    expect(buildDropIndex('mysql', { table: 'users', name: 'idx_email' })).toBe('DROP INDEX `idx_email` ON `users`');
  });
  it('postgres: index name only', () => {
    expect(buildDropIndex('postgres', { table: 'users', name: 'idx_email' })).toBe('DROP INDEX "idx_email"');
  });
  it('sqlserver: needs the table (like mysql)', () => {
    expect(buildDropIndex('sqlserver', { table: 'users', name: 'idx_email' })).toBe('DROP INDEX [idx_email] ON [users]');
  });
});
