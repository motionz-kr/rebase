// Human-readable download size + ETA for the auto-update progress UI.

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // Bytes are whole; KB+ get one decimal.
  return i === 0 ? `${Math.round(v)} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`;
}

// "약 18초 남음" / "약 3분 남음"; empty string when speed is unknown.
export function formatEta(bytesPerSecond: number, remainingBytes: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
  const secs = Math.max(1, Math.ceil(remainingBytes / bytesPerSecond));
  if (secs < 60) return `약 ${secs}초 남음`;
  return `약 ${Math.ceil(secs / 60)}분 남음`;
}
