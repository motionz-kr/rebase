import { describe, expect, it } from 'vitest';
import { splitStatementRanges } from './splitStatements';
import { createMultiStatementResumePlan } from './multiStatementResume';

describe('createMultiStatementResumePlan', () => {
  const ranges = splitStatementRanges('CREATE TABLE t (id INT); UPDATE t SET id = 2; SELECT * FROM t;');

  it('resumes at the blocked statement without replaying earlier statements', () => {
    expect(createMultiStatementResumePlan(ranges, 1)).toMatchObject({
      startIndex: 1,
      statements: ['UPDATE t SET id = 2', 'SELECT * FROM t'],
    });
  });

  it('keeps the original range order and source offsets for the resumed statements', () => {
    const plan = createMultiStatementResumePlan(ranges, 1);

    expect(plan?.ranges).toEqual(ranges);
    expect(plan?.ranges.slice(plan.startIndex)).toEqual(ranges.slice(1));
  });

  it('returns null when there is no statement left to resume', () => {
    expect(createMultiStatementResumePlan(ranges, ranges.length)).toBeNull();
    expect(createMultiStatementResumePlan(ranges, -1)).toBeNull();
  });
});
