import { describe, expect, test } from 'vitest';
import { filterQueryHistory, type QueryHistoryFilter } from './queryHistory';

const entries: QueryHistoryFilter[] = [
  { name: 'Active customers', queryText: 'SELECT * FROM customers WHERE active = 1', success: true },
  { name: 'Fix customer status', queryText: 'UPDATE customers SET active = 0', success: false },
  { name: 'Recent orders', queryText: 'SELECT * FROM orders ORDER BY created_at DESC', success: true },
];

describe('filterQueryHistory', () => {
  test('returns all entries when no filters are selected', () => {
    expect(filterQueryHistory(entries, '', 'all')).toEqual(entries);
  });

  test('searches query titles and SQL without case sensitivity', () => {
    expect(filterQueryHistory(entries, 'CUSTOMERS', 'all')).toEqual(entries.slice(0, 2));
    expect(filterQueryHistory(entries, 'order by', 'all')).toEqual([entries[2]]);
  });

  test('filters by successful or failed executions', () => {
    expect(filterQueryHistory(entries, '', 'success')).toEqual([entries[0], entries[2]]);
    expect(filterQueryHistory(entries, '', 'failed')).toEqual([entries[1]]);
  });

  test('combines text and status filters', () => {
    expect(filterQueryHistory(entries, 'customers', 'failed')).toEqual([entries[1]]);
    expect(filterQueryHistory(entries, 'orders', 'failed')).toEqual([]);
  });

  test('trims search text and supports entries without a title', () => {
    const unnamed = { queryText: 'SELECT 42', success: true };
    expect(filterQueryHistory([unnamed], '  select 42  ', 'all')).toEqual([unnamed]);
  });
});
