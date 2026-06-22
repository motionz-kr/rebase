export type UpdateStatus =
  | { kind: 'checking' }
  | { kind: 'available'; version: string; notes?: string }
  | { kind: 'not-available' }
  | { kind: 'progress'; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

function notesToString(notes: unknown): string | undefined {
  if (typeof notes === 'string') return notes;
  return undefined; // release notes can be an array of objects; keep it simple
}

function errorMessage(payload: unknown): string {
  return payload instanceof Error ? payload.message : String(payload);
}

export function isUpdateMetadataPendingError(payload: unknown): boolean {
  const message = errorMessage(payload);
  return /Cannot find latest(?:-[a-z0-9]+)?\.yml in the latest release artifacts/i.test(message) && /\b404\b/.test(message);
}

export function mapUpdaterEvent(event: string, payload: unknown): UpdateStatus | null {
  const p = (payload ?? {}) as {
    version?: string;
    releaseNotes?: unknown;
    percent?: number;
    transferred?: number;
    total?: number;
    bytesPerSecond?: number;
  };
  switch (event) {
    case 'checking-for-update':
      return { kind: 'checking' };
    case 'update-available':
      return { kind: 'available', version: p.version ?? '', notes: notesToString(p.releaseNotes) };
    case 'update-not-available':
      return { kind: 'not-available' };
    case 'download-progress':
      return {
        kind: 'progress',
        percent: Math.round(p.percent ?? 0),
        transferred: p.transferred ?? 0,
        total: p.total ?? 0,
        bytesPerSecond: p.bytesPerSecond ?? 0,
      };
    case 'update-downloaded':
      return { kind: 'downloaded', version: p.version ?? '' };
    case 'error':
      if (isUpdateMetadataPendingError(payload)) return null;
      return { kind: 'error', message: errorMessage(payload) };
    default:
      return null;
  }
}
