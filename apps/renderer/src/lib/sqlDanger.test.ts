import { describe, it, expect } from 'vitest';
import { classifyStatement } from './sqlDanger';

describe('classifyStatement', () => {
  it('flags WHERE-less DELETE/UPDATE, DROP, TRUNCATE, ALTER…DROP', () => {
    expect(classifyStatement('DELETE FROM users').risk).toBe('dangerous');
    expect(classifyStatement('UPDATE users SET a=1').risk).toBe('dangerous');
    expect(classifyStatement('DROP TABLE users').risk).toBe('dangerous');
    expect(classifyStatement('truncate table t').risk).toBe('dangerous');
    expect(classifyStatement('ALTER TABLE t DROP COLUMN c').risk).toBe('dangerous');
  });

  it('treats scoped writes and reads as safe', () => {
    expect(classifyStatement('DELETE FROM users WHERE id=1').risk).toBe('safe');
    expect(classifyStatement('UPDATE users SET a=1 WHERE id=2').risk).toBe('safe');
    expect(classifyStatement('INSERT INTO users (id) VALUES (1)').risk).toBe('safe');
    expect(classifyStatement('SELECT * FROM users').risk).toBe('safe');
  });

  it('is not fooled by WHERE inside a comment', () => {
    expect(classifyStatement('DELETE FROM logs -- WHERE keep').risk).toBe('dangerous');
  });

  it('explains dangerous results', () => {
    expect(classifyStatement('DROP TABLE x').reasons.length).toBeGreaterThan(0);
  });
});
