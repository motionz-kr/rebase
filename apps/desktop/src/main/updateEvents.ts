export type UpdateStatus =
  | { kind: 'checking' }
  | { kind: 'available'; version: string; notes?: string }
  | { kind: 'not-available' }
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

function notesToString(notes: unknown): string | undefined {
  if (typeof notes === 'string') return notes;
  return undefined; // release notes can be an array of objects; keep it simple
}

export function mapUpdaterEvent(event: string, payload: unknown): UpdateStatus | null {
  const p = (payload ?? {}) as { version?: string; releaseNotes?: unknown; percent?: number };
  switch (event) {
    case 'checking-for-update':
      return { kind: 'checking' };
    case 'update-available':
      return { kind: 'available', version: p.version ?? '', notes: notesToString(p.releaseNotes) };
    case 'update-not-available':
      return { kind: 'not-available' };
    case 'download-progress':
      return { kind: 'progress', percent: Math.round(p.percent ?? 0) };
    case 'update-downloaded':
      return { kind: 'downloaded', version: p.version ?? '' };
    case 'error':
      return { kind: 'error', message: payload instanceof Error ? payload.message : String(payload) };
    default:
      return null;
  }
}
