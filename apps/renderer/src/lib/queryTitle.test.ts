import { describe, expect, it } from 'vitest';
import { fallbackQueryTitle, normalizeGeneratedTitle, redactQueryForTitle } from './queryTitle';

describe('queryTitle', () => {
  it('builds a concise SQL title from the main verb and table', () => {
    expect(fallbackQueryTitle('select id, email from public.users where email = "a@example.com"')).toBe('SELECT public.users');
    expect(fallbackQueryTitle('UPDATE orders SET status = "paid" WHERE id = 7')).toBe('UPDATE orders');
  });

  it('builds Redis and Mongo command titles', () => {
    expect(fallbackQueryTitle('GET user:1001')).toBe('GET user:1001');
    expect(fallbackQueryTitle('db.customers.find({ active: true })')).toBe('customers find');
  });

  it('normalizes generated titles into one short plain line', () => {
    expect(normalizeGeneratedTitle('### "Active users lookup"\nextra detail')).toBe('Active users lookup');
    expect(normalizeGeneratedTitle('')).toBe('');
  });

  it('redacts literal values before sending query text for title generation', () => {
    expect(redactQueryForTitle("SELECT * FROM users WHERE email = 'a@example.com' AND id = 123")).toBe(
      "SELECT * FROM users WHERE email = '?' AND id = ?",
    );
  });
});
