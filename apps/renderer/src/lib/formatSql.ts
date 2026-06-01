import { format, type SqlLanguage } from 'sql-formatter';

// Map our connection drivers to sql-formatter dialects. Anything we don't have
// a specific dialect for falls back to standard SQL.
export function dialectFor(driver: string): SqlLanguage {
  switch (driver) {
    case 'mysql':
      return 'mysql';
    case 'postgres':
      return 'postgresql';
    default:
      return 'sql';
  }
}

// Pretty-print a SQL string for the given driver. Returns the original text
// unchanged if the SQL can't be parsed, so the user never loses their query.
export function formatSql(query: string, driver: string): string {
  if (!query.trim()) return '';
  try {
    return format(query, {
      language: dialectFor(driver),
      keywordCase: 'upper',
      tabWidth: 2,
      linesBetweenQueries: 1,
    });
  } catch {
    return query;
  }
}
