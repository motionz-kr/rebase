import { describe, expect, it } from 'vitest';
import { formatQueryTabLabel } from './queryTabLabel';

describe('formatQueryTabLabel', () => {
  it('includes the schema name when one is selected', () => {
    expect(formatQueryTabLabel('Query 1', 'analytics')).toBe('Query 1 · analytics');
  });

  it('keeps the tab name when the schema is empty', () => {
    expect(formatQueryTabLabel('Query 1', '  ')).toBe('Query 1');
  });
});
