import { describe, expect, it } from 'vitest';
import { withExplicitRiskApproval } from './queryApproval';

describe('withExplicitRiskApproval', () => {
  it('turns one risk-dialog confirmation into write, destructive, and acknowledgement approval', () => {
    expect(withExplicitRiskApproval({
      allowWrite: false,
      confirmDestructive: false,
      acknowledged: false,
    })).toEqual({
      allowWrite: true,
      confirmDestructive: true,
      acknowledged: true,
    });
  });

  it('preserves the pending query continuation options', () => {
    expect(withExplicitRiskApproval({
      sqlOverride: 'UPDATE users SET active = 0 WHERE id = 1',
      databaseOverride: 'devdb',
    })).toEqual({
      sqlOverride: 'UPDATE users SET active = 0 WHERE id = 1',
      databaseOverride: 'devdb',
      allowWrite: true,
      confirmDestructive: true,
      acknowledged: true,
    });
  });
});
