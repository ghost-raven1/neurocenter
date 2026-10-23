/** Waiting never holds a PostgreSQL transaction, client, or provider request. */
export function modelRateWait(ms: number, signal?: AbortSignal): Promise<void> {
 signal?.throwIfAborted();
 return new Promise((resolve, reject) => {
  const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
 });
}

/** A slow SQL authorization can finish later, but it cannot resume an aborted dispatch attempt. */
export function modelRateBeforeAttempt<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
 signal?.throwIfAborted();
 return new Promise<T>((resolve, reject) => {
  const cleanup = () => signal?.removeEventListener('abort', aborted);
  const aborted = () => { cleanup(); reject(signal?.reason); };
  signal?.addEventListener('abort', aborted, { once: true });
  Promise.resolve().then(() => { signal?.throwIfAborted(); return action(); }).then(
   value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
 });
}
