export interface QueryExecutionApproval {
  [key: string]: unknown;
  allowWrite?: boolean;
  confirmDestructive?: boolean;
  acknowledged?: boolean;
}

interface ExplicitRiskApproval {
  allowWrite: true;
  confirmDestructive: true;
  acknowledged: true;
}

/**
 * Converts the user's explicit risk-dialog confirmation into approval for this
 * execution only. The editor's persistent Read-only/Write mode is unchanged.
 */
export function withExplicitRiskApproval<T extends QueryExecutionApproval>(
  override?: T,
): T & ExplicitRiskApproval {
  return {
    ...override,
    allowWrite: true,
    confirmDestructive: true,
    acknowledged: true,
  } as T & ExplicitRiskApproval;
}
