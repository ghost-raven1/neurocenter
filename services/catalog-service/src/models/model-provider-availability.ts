const unavailable = new WeakSet<Error>();

/** Only trusted transport owners classify an outage; provider JSON cannot forge this process-local marker. */
export function markModelProviderUnavailable<T extends Error>(error: T): T { unavailable.add(error); return error; }
export function isModelProviderUnavailable(error: unknown): error is Error { return error instanceof Error && unavailable.has(error); }
