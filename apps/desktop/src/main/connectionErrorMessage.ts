// Connection-test responses may carry a JSON error envelope from the engine.
export function connectionErrorMessage(message: string): string {
  try {
    const payload: unknown = JSON.parse(message);
    if (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string') {
      return payload.error;
    }
  } catch { /* Plain-text engine errors already have a useful message. */ }
  return message;
}
