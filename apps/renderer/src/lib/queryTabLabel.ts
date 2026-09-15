export function formatQueryTabLabel(name: string, database: string): string {
  const schema = database.trim();
  return schema ? `${name} · ${schema}` : name;
}
