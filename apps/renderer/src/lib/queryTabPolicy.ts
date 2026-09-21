/**
 * The connection profile is the hard policy boundary. A query tab can choose
 * Write only when its owning connection is not configured as read-only.
 */
export function canEnableTabWrite(profileReadOnly: boolean, nextWriteMode: boolean): boolean {
  return !profileReadOnly || !nextWriteMode;
}

export function resolveTabWriteMode(profileReadOnly: boolean, tabWriteMode: boolean): boolean {
  return profileReadOnly ? false : tabWriteMode;
}

/**
 * Per-run overrides are still useful for the risk confirmation flow, but they
 * must never bypass the connection profile's read-only guard.
 */
export function resolveQueryAllowWrite(
  profileReadOnly: boolean,
  tabWriteMode: boolean,
  override?: boolean,
): boolean {
  if (profileReadOnly) return false;
  return override ?? tabWriteMode;
}
