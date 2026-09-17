export interface McpAccessScope {
  allowedDatabases: string[];
  allowedSchemas: string[];
  allowedTables: string[];
}

export function parseScopeList(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

export function scopeFromProfile(databases?: string, schemas?: string, tables?: string): McpAccessScope {
  const decode = (raw?: string) => {
    if (!raw?.trim()) return [];
    try {
      const value = JSON.parse(raw);
      if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
    } catch {
      // Older/manual values can still be edited as newline/comma lists.
    }
    return parseScopeList(raw);
  };
  return {
    allowedDatabases: decode(databases),
    allowedSchemas: decode(schemas),
    allowedTables: decode(tables),
  };
}

export function scopeText(values: string[]): string {
  return values.join('\n');
}
