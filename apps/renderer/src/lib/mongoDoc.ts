// Pure helpers for the MongoDB document grid / JSON view.
// No IO / DOM — fully unit-testable.

/**
 * Parse a (possibly Extended-) JSON document string and return a top-level
 * field → cell map for the grid. Nested objects/arrays become compact JSON
 * strings; scalars are stringified (unquoted). Returns {} if it can't parse.
 */
export function flattenDocument(extJson: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extJson);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object') {
      out[key] = JSON.stringify(value);
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

/**
 * Given an array of doc JSON strings, return the union of top-level keys in
 * first-seen order, with `_id` hoisted to the front when present.
 */
export function columnsFor(docs: string[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];

  for (const doc of docs) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(doc);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      continue;
    }
    for (const key of Object.keys(parsed as Record<string, unknown>)) {
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
  }

  if (seen.has('_id')) {
    return ['_id', ...order.filter((k) => k !== '_id')];
  }
  return order;
}

/**
 * Pretty-print a doc JSON string with 2-space indentation. Returns the input
 * unchanged if it can't be parsed.
 */
export function formatExtJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

/**
 * Extract the `_id` of a document as an ext-JSON scalar string suitable for the
 * mongoReplace/mongoDelete `id` argument. Returns '' if absent/unparseable.
 * An `_id` like `{"$oid":"..."}` round-trips as a JSON object string.
 */
export function extractId(docJson: string): string {
  try {
    const parsed = JSON.parse(docJson) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && '_id' in parsed) {
      return JSON.stringify(parsed._id);
    }
  } catch {
    /* ignore */
  }
  return '';
}
