// Suggest role→column bindings for a connection from its column names + the
// safe-mode tenant columns. Pure, best-effort: returns only confident matches.
const PATTERNS: Record<string, RegExp> = {
  tenant: /^(tenant|hospital|org|company|account)_?id$|^(tenant|hospital|org)$/i,
  soft_delete: /^(deleted_?at|is_?deleted|removed_?at)$/i,
};

export function suggestBindings(columns: string[], tenantColumns: string[]): Record<string, string> {
  const lower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  const out: Record<string, string> = {};

  // tenant: prefer a configured tenant column that exists, else pattern match.
  for (const tc of tenantColumns) {
    if (lower.has(tc.toLowerCase())) {
      out.tenant = lower.get(tc.toLowerCase())!;
      break;
    }
  }
  for (const [role, re] of Object.entries(PATTERNS)) {
    if (out[role]) continue;
    const hit = columns.find((c) => re.test(c));
    if (hit) out[role] = hit;
  }
  return out;
}
