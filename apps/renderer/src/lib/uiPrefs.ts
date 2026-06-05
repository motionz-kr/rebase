export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 600;
export const SIDEBAR_DEFAULT = 290;

// Clamp a sidebar width to [MIN, MAX], rounding; NaN/Infinity → default.
export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));
}

export const MODAL_MIN = 380;
export const MODAL_MAX = 900;
export const MODAL_DEFAULT = 560;

// Clamp a dialog width to [MIN, MAX], rounding; NaN/Infinity → default.
export function clampModalWidth(px: number): number {
  if (!Number.isFinite(px)) return MODAL_DEFAULT;
  return Math.min(MODAL_MAX, Math.max(MODAL_MIN, Math.round(px)));
}

// Read a single number under a key, swallowing storage/parse errors.
export function loadNum(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}
export function saveNum(key: string, n: number): void {
  try {
    localStorage.setItem(key, String(n));
  } catch {
    /* ignore */
  }
}
