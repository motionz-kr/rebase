import { describe, it, expect } from 'vitest';
import { suggestBindings } from './suggestBindings';

describe('suggestBindings', () => {
  it('binds tenant from tenantColumns when present in schema', () => {
    const b = suggestBindings(['id', 'hospitalId', 'deletedAt', 'phone'], ['hospitalId', 'tenantId']);
    expect(b.tenant).toBe('hospitalId');
    expect(b.soft_delete).toBe('deletedAt');
  });
  it('falls back to name matching for tenant when tenantColumns absent', () => {
    const b = suggestBindings(['id', 'org_id', 'is_deleted'], []);
    expect(b.tenant).toBe('org_id');
    expect(b.soft_delete).toBe('is_deleted');
  });
  it('omits a role when no candidate matches', () => {
    const b = suggestBindings(['id', 'name'], []);
    expect(b.tenant).toBeUndefined();
    expect(b.soft_delete).toBeUndefined();
  });
});
